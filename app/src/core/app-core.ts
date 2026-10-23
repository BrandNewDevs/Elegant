import type { Engine } from "../engine/protocol.js";
import type { PipelineStages } from "../pipeline/pipeline.js";
import { DEFAULT_DETECTION, MicWatcher, type DetectionSettings } from "./detection.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { Meeting, MeetingListItem, Store } from "../store/store.js";

export type EngineStatus = "starting" | "running" | "stopped" | "crashed";

export interface AppCoreDeps {
  engine: Engine;
  store: Store;
  pipeline: PipelineStages;
  detection?: Partial<DetectionSettings>;
}

/** A Meeting the app has noticed but not yet been told to record. It lives in memory only; nothing is stored for it. */
export interface DetectedMeeting {
  state: "detected";
  app: string;
  detectedAt: string;
}

/** The Recording in progress, until the user presses Stop. */
export interface ActiveRecording {
  app: string;
  startedAt: string;
}

/** Owns the Meeting lifecycle: reacts to what the engine reports and drives the pipeline and the store. */
export class AppCore {
  private _status: EngineStatus = "stopped";
  private stopping = false;
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private meetingsListeners: (() => void)[] = [];
  private readonly runner: PipelineRunner;
  private recordingMeetingId: number | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly micWatcher: MicWatcher;
  private readonly promptTimeoutMs: number;
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private _detectedMeeting: DetectedMeeting | undefined;
  private detectedListeners: ((meeting: DetectedMeeting | undefined) => void)[] = [];
  private _recording: ActiveRecording | undefined;
  private recordingListeners: ((recording: ActiveRecording | undefined) => void)[] = [];

  private readonly store: Store;

  constructor(private readonly deps: AppCoreDeps) {
    this.store = this.notifyingStore(deps.store);
    this.runner = new PipelineRunner(deps.pipeline, this.store);
    const detection = { ...DEFAULT_DETECTION, ...deps.detection };
    this.promptTimeoutMs = detection.promptTimeoutMs;
    this.micWatcher = new MicWatcher(detection, {
      detected: (app) => this.onDetected(app),
      released: (app) => {
        if (this._detectedMeeting?.app === app) this.declinePrompt();
      },
    });
    deps.engine.onEvent((event) => {
      switch (event.type) {
        case "ready":
          this.setStatus("running");
          break;
        case "mic_in_use_started":
          this.micWatcher.micStarted(event.app, event.pid);
          break;
        case "mic_in_use_stopped":
          this.micWatcher.micStopped(event.app, event.pid);
          break;
        case "recording_started":
          this.abandonRecording("the recording was interrupted by a new one");
          this.recordingMeetingId = this.store.createMeeting({ app: event.app, startedAt: event.startedAt });
          this.setRecording({ app: event.app, startedAt: event.startedAt });
          break;
        case "tracks_ready": {
          const id = this.recordingMeetingId;
          if (id === undefined) break;
          this.recordingMeetingId = undefined;
          this.setRecording(undefined);
          this.track(this.runner.run(id, { micPath: event.micPath, systemPath: event.systemPath }));
          break;
        }
        case "recording_failed":
          this.abandonRecording(event.message);
          break;
      }
    });
    deps.engine.onExit(() => {
      this.micWatcher.reset();
      this.clearDetectedMeeting();
      this.abandonRecording("the engine stopped during the recording");
      this.setStatus(this.stopping ? "stopped" : "crashed");
    });
  }

  get status(): EngineStatus {
    return this._status;
  }

  onStatusChange(listener: (status: EngineStatus) => void): void {
    this.statusListeners.push(listener);
  }

  /** The Meeting the Prompt is asking about, if any. */
  get detectedMeeting(): DetectedMeeting | undefined {
    return this._detectedMeeting;
  }

  onDetectedMeetingChange(listener: (meeting: DetectedMeeting | undefined) => void): void {
    this.detectedListeners.push(listener);
  }

  /** The user chose Record. */
  acceptPrompt(): void {
    const meeting = this._detectedMeeting;
    if (!meeting) return;
    this.clearDetectedMeeting();
    this.deps.engine.send({ type: "start_recording", app: meeting.app });
  }

  /** The user chose Not now, the Prompt timed out, or the call ended. Nothing about the Meeting is kept. */
  declinePrompt(): void {
    if (!this.clearDetectedMeeting()) return;
    this.deps.engine.send({ type: "discard_buffer" });
  }

  /** The Recording in progress, if any. It ends when the user presses Stop, and at no other time. */
  get recording(): ActiveRecording | undefined {
    return this._recording;
  }

  onRecordingChange(listener: (recording: ActiveRecording | undefined) => void): void {
    this.recordingListeners.push(listener);
  }

  /** The user pressed Stop. The engine answers with the finished tracks. */
  stopRecording(): void {
    if (!this._recording) return;
    this.setRecording(undefined);
    this.deps.engine.send({ type: "stop_recording" });
  }

  /** Called whenever a Meeting appears or changes state, so a window can refresh. */
  onMeetingsChanged(listener: () => void): void {
    this.meetingsListeners.push(listener);
  }

  listMeetings(): MeetingListItem[] {
    return this.store.listMeetings();
  }

  getMeeting(id: number): Meeting | undefined {
    return this.store.getMeeting(id);
  }

  /** Summarises a failed Meeting again from its stored Transcript, e.g. once Ollama is running. */
  async retrySummary(id: number): Promise<void> {
    const meeting = this.deps.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    if (meeting.state !== "failed") throw new Error(`only a failed Meeting can be retried, and this one is ${meeting.state}`);
    if (meeting.transcript.segments.length === 0) throw new Error("this Meeting has no Transcript to summarise");
    await this.track(this.runner.resummarise(id, meeting.transcript));
  }

  /** Resolves when no Recording is being processed. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  start(): void {
    this.stopping = false;
    this.setStatus("starting");
    this.deps.engine.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.deps.engine.send({ type: "shutdown" });
    await this.deps.engine.stop();
    this.setStatus("stopped");
  }

  private track(job: Promise<void>): Promise<void> {
    this.inFlight.add(job);
    void job.finally(() => this.inFlight.delete(job));
    return job;
  }

  private onDetected(app: string): void {
    // One Meeting at a time: ignore a second app while a Prompt is showing or a Recording is running.
    if (this._detectedMeeting || this.recordingMeetingId !== undefined) return;
    this._detectedMeeting = { state: "detected", app, detectedAt: new Date().toISOString() };
    this.promptTimer = setTimeout(() => this.declinePrompt(), this.promptTimeoutMs);
    this.notifyDetected();
  }

  /** Returns whether there was a detected Meeting to clear. */
  private clearDetectedMeeting(): boolean {
    if (!this._detectedMeeting) return false;
    clearTimeout(this.promptTimer);
    this._detectedMeeting = undefined;
    this.notifyDetected();
    return true;
  }

  private notifyDetected(): void {
    for (const l of this.detectedListeners) l(this._detectedMeeting);
  }

  /** A Recording that can no longer finish is marked failed, so no Meeting is left stuck as recording. */
  private abandonRecording(reason: string): void {
    this.setRecording(undefined);
    const id = this.recordingMeetingId;
    if (id === undefined) return;
    this.recordingMeetingId = undefined;
    this.store.setMeetingState(id, "failed", reason);
  }

  private notifyingStore(store: Store): Store {
    const notify = () => {
      for (const listener of this.meetingsListeners) {
        // A broken window must not stop a Meeting's state from being recorded.
        try {
          listener();
        } catch (err) {
          console.error("[meetings] listener failed", err);
        }
      }
    };
    return {
      ...store,
      createMeeting: (input) => {
        const id = store.createMeeting(input);
        notify();
        return id;
      },
      setMeetingState: (id, state, error) => {
        store.setMeetingState(id, state, error);
        notify();
      },
    };
  }

  private setRecording(recording: ActiveRecording | undefined): void {
    if (!this._recording && !recording) return;
    this._recording = recording;
    for (const l of this.recordingListeners) l(recording);
  }

  private setStatus(status: EngineStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const l of this.statusListeners) l(status);
  }
}
