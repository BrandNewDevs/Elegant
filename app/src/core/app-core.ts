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

/** Owns the Meeting lifecycle: reacts to what the engine reports and drives the pipeline and the store. */
export class AppCore {
  private _status: EngineStatus = "stopped";
  private stopping = false;
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private readonly runner: PipelineRunner;
  private recordingMeetingId: number | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly micWatcher: MicWatcher;
  private readonly promptTimeoutMs: number;
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private _detectedMeeting: DetectedMeeting | undefined;
  private detectedListeners: ((meeting: DetectedMeeting | undefined) => void)[] = [];

  constructor(private readonly deps: AppCoreDeps) {
    this.runner = new PipelineRunner(deps.pipeline, deps.store);
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
          this.recordingMeetingId = deps.store.createMeeting({ app: event.app, startedAt: event.startedAt });
          break;
        case "tracks_ready": {
          const id = this.recordingMeetingId;
          if (id === undefined) break;
          this.recordingMeetingId = undefined;
          const job = this.runner.run(id, { micPath: event.micPath, systemPath: event.systemPath });
          this.inFlight.add(job);
          void job.finally(() => this.inFlight.delete(job));
          break;
        }
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
    if (!this.clearDetectedMeeting()) return;
    this.deps.engine.send({ type: "start_recording" });
  }

  /** The user chose Not now, the Prompt timed out, or the call ended. Nothing about the Meeting is kept. */
  declinePrompt(): void {
    if (!this.clearDetectedMeeting()) return;
    this.deps.engine.send({ type: "discard_buffer" });
  }

  listMeetings(): MeetingListItem[] {
    return this.deps.store.listMeetings();
  }

  getMeeting(id: number): Meeting | undefined {
    return this.deps.store.getMeeting(id);
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
    const id = this.recordingMeetingId;
    if (id === undefined) return;
    this.recordingMeetingId = undefined;
    this.deps.store.setMeetingState(id, "failed", reason);
  }

  private setStatus(status: EngineStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const l of this.statusListeners) l(status);
  }
}
