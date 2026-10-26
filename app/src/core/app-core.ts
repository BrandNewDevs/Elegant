import { randomUUID } from "node:crypto";
import { AIJobQueue } from "../pipeline/job-queue.js";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Engine } from "../engine/protocol.js";
import type { PipelineContext, PipelineStages } from "../pipeline/pipeline.js";
import { exportFileName, meetingToMarkdown } from "./export-markdown.js";
import { DEFAULT_DETECTION, MicWatcher, type DetectionSettings } from "./detection.js";
import { applyNames, USER_NAME_SETTING } from "./participants.js";
import { MeetingChatController } from "./meeting-chat-controller.js";
import type { MeetingChatGenerator } from "../pipeline/meeting-chat.js";
import type { ChatRecord } from "../shared/meeting-chat.js";
import { resolveReference, transcriptRevision, type TranscriptReference } from "../pipeline/evidence.js";
import { discardAudio, PipelineRunner } from "../pipeline/runner.js";
import type { Meeting, MeetingListItem, Store } from "../store/store.js";

/** The store setting behind `AppCore.keepAudio`. */
const KEEP_AUDIO_SETTING = "keepAudio";

/** The store setting behind `AppCore.neverApps`: a JSON array of app names. */
const NEVER_APPS_SETTING = "neverApps";

/** How long to wait for the engine to hand over the tracks after Stop before giving up on the Recording. */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000;

export type EngineStatus = "starting" | "running" | "stopped" | "crashed";

export interface AppCoreDeps {
  engine: Engine;
  store: Store;
  pipeline: PipelineStages;
  detection?: Partial<DetectionSettings>;
  /** Extra apps to ignore for Detection, asked at each microphone event so edits apply at once. */
  extraIgnoredApps?: () => readonly string[];
  stopTimeoutMs?: number;
  jobs?: AIJobQueue;
  chat?: MeetingChatGenerator;
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
  private recoverOnStart = true;
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private meetingsListeners: (() => void)[] = [];
  private readonly runner: PipelineRunner;
  private recordingMeetingId: number | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly deletingMeetings = new Set<number>();
  private readonly micWatcher: MicWatcher;
  private readonly promptTimeoutMs: number;
  private promptTimer: ReturnType<typeof setTimeout> | undefined;
  private _detectedMeeting: DetectedMeeting | undefined;
  private detectedListeners: ((meeting: DetectedMeeting | undefined) => void)[] = [];
  private _recording: ActiveRecording | undefined;
  private recordingListeners: ((recording: ActiveRecording | undefined) => void)[] = [];
  private recordingFailedListeners: ((message: string) => void)[] = [];
  private stopNudgeListeners: ((app: string) => void)[] = [];
  private recordingSettledWaiters: (() => void)[] = [];
  private stopTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly store: Store;
  readonly jobs: AIJobQueue;
  private readonly chatController: MeetingChatController;

  constructor(private readonly deps: AppCoreDeps) {
    this.store = this.notifyingStore(deps.store);
    this.jobs = deps.jobs ?? new AIJobQueue();
    this.runner = new PipelineRunner(deps.pipeline, this.store, { keepAudio: () => this.keepAudio });
    this.chatController = new MeetingChatController({ store: this.store, jobs: this.jobs, generate: deps.chat, ownName: () => this.userName,
      isAvailable: id => this.isChatAvailable(id) });
    let previousOwners = new Set<string>();
    this.jobs.onChange(state => {
      const currentOwners = new Set(state.map(job => job.owner));
      for (const owner of new Set([...previousOwners, ...currentOwners])) {
        const match = /^(?:meeting|chat):(\d+)$/.exec(owner);
        if (match) this.chatController.refresh(Number(match[1]));
      }
      previousOwners = currentOwners;
    });
    const detection = { ...DEFAULT_DETECTION, ...deps.detection };
    this.promptTimeoutMs = detection.promptTimeoutMs;
    const extraIgnoredApps = deps.extraIgnoredApps ?? (() => []);
    this.micWatcher = new MicWatcher(
      { debounceMs: detection.debounceMs, ignoredMicApps: detection.ignoredMicApps, extraIgnoredApps },
      {
        detected: (app) => this.onDetected(app),
        released: (app) => {
          if (this._detectedMeeting?.app === app) this.declinePrompt();
          else if (this._recording?.app === app) for (const l of this.stopNudgeListeners) l(app);
        },
      },
    );
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
          this.settleRecording();
          if (this.stopping) {
            // The app is quitting, so the pipeline would be cut off. Keep the audio and say where it is.
            const where = dirname(event.micPath);
            this.store.saveAudio(id, { micPath: event.micPath, systemPath: event.systemPath });
            this.store.setMeetingState(id, "failed", `the app quit before this Recording was processed; the audio is in ${where}`);
          } else {
            // Queued work may be cancelled before the runner starts; retain paths immediately for retry.
            this.store.saveAudio(id, { micPath: event.micPath, systemPath: event.systemPath });
            this.pipelineJob(id, "transcription-and-summary", context => this.runner.run(id, { micPath: event.micPath, systemPath: event.systemPath }, context));
          }
          break;
        }
        case "recording_failed":
          this.abandonRecording(event.message);
          for (const l of this.recordingFailedListeners) l(event.message);
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

  /** The user chose Never for this app. Nothing about the Meeting is kept, and the app is not asked about again. */
  neverForThisApp(): void {
    const meeting = this._detectedMeeting;
    if (!meeting) return;
    this.deps.store.setSetting(NEVER_APPS_SETTING, JSON.stringify([...this.neverApps, meeting.app]));
    this.declinePrompt();
  }

  /** The apps the user chose Never for, in the order they were chosen. */
  get neverApps(): string[] {
    const stored = this.deps.store.getSetting(NEVER_APPS_SETTING);
    return stored ? (JSON.parse(stored) as string[]) : [];
  }

  /** Undoes Never for this app: the next Detection of it shows the Prompt again. */
  allowApp(app: string): void {
    const name = app.toLowerCase();
    this.deps.store.setSetting(NEVER_APPS_SETTING, JSON.stringify(this.neverApps.filter((a) => a.toLowerCase() !== name)));
  }

  /** The Recording in progress, if any. It ends when the user presses Stop, and at no other time. */
  get recording(): ActiveRecording | undefined {
    return this._recording;
  }

  onRecordingChange(listener: (recording: ActiveRecording | undefined) => void): void {
    this.recordingListeners.push(listener);
  }

  /** Called with the reason when a Recording cannot start or cannot finish. */
  onRecordingFailed(listener: (message: string) => void): void {
    this.recordingFailedListeners.push(listener);
  }

  /**
   * Called when the call app lets go of the microphone during a Recording, as a reminder to press Stop. It only
   * reminds: the Recording runs on until the user presses Stop.
   */
  onStopNudge(listener: (app: string) => void): void {
    this.stopNudgeListeners.push(listener);
  }

  /** The user pressed Stop. The engine answers with the finished tracks. */
  stopRecording(): void {
    if (!this._recording) return;
    this.setRecording(undefined);
    this.deps.engine.send({ type: "stop_recording" });
    // If the engine never answers, the Meeting must not stay "recording" for ever.
    this.stopTimer = setTimeout(
      () => this.abandonRecording("the engine did not hand over the tracks after Stop"),
      this.deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    );
  }

  /** Called whenever a Meeting appears or changes state, so a window can refresh. */
  onMeetingsChanged(listener: () => void): void {
    this.meetingsListeners.push(listener);
  }

  listMeetings(): MeetingListItem[] {
    return this.store.listMeetings();
  }

  /** The Meetings whose Transcript or Summary matches the query, newest first. */
  searchMeetings(query: string): MeetingListItem[] {
    return this.store.searchMeetings(query);
  }

  getMeeting(id: number): Meeting | undefined {
    return this.store.getMeeting(id);
  }

  /** One Meeting as Markdown, with a suggested file name. */
  exportMeeting(id: number): { fileName: string; markdown: string } {
    const meeting = this.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    return { fileName: exportFileName(meeting), markdown: meetingToMarkdown(meeting, this.userName) };
  }

  /** The person's own name, shown in place of "You"; undefined until they give one. */
  private get userName(): string | undefined {
    return this.store.getSetting(USER_NAME_SETTING) || undefined;
  }

  /** The Meeting as it is shown: each Participant's chosen name stands in for their label, in the Transcript and the Summary. */
  getMeetingForDisplay(id: number): Meeting | undefined {
    const meeting = this.store.getMeeting(id);
    return meeting && applyNames(meeting, this.userName);
  }

  /**
   * Names a Participant in one Meeting, or clears the name if it is blank. Only what is displayed changes: the stored
   * Transcript and Summary keep the labels, so a regenerated Summary is unaffected.
   */
  renameParticipant(meetingId: number, label: string, name: string): void {
    this.store.renameParticipant(meetingId, label, name.trim() || null);
    this.chatController.refresh(meetingId);
  }

  /** Whether a Recording's audio is kept after it is transcribed. Off by default: the audio is deleted. */
  get keepAudio(): boolean {
    return this.deps.store.getSetting(KEEP_AUDIO_SETTING) === "true";
  }

  /** Applies from the next transcription on. */
  setKeepAudio(keep: boolean): void {
    this.deps.store.setSetting(KEEP_AUDIO_SETTING, String(keep));
  }

  /** Removes a Meeting and all its data, including any kept audio. */
  async deleteMeeting(id: number): Promise<void> {
    this.assertNotDeleting(id);
    const meeting = this.deps.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    // The pipeline is still writing to a Meeting in these states.
    if (meeting.state === "recording" || meeting.state === "processing") {
      throw new Error(`a Meeting that is ${meeting.state} cannot be deleted yet`);
    }
    // Reserve the Meeting before cancellation notifies views or audio removal yields to another action.
    this.deletingMeetings.add(id);
    try {
      this.chatController.clear(id);
      if (meeting.audio) await discardAudio(meeting.audio);
      this.chatController.clear(id);
      this.store.deleteMeeting(id);
    } finally {
      this.deletingMeetings.delete(id);
      // A failed audio removal leaves the Meeting recoverable and chat available again.
      this.chatController.refresh(id);
    }
  }

  /** Summarises a failed Meeting again from its stored Transcript, e.g. once Ollama is running. */
  async retrySummary(id: number): Promise<void> {
    this.assertNotDeleting(id);
    const meeting = this.deps.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    if (meeting.state !== "failed") throw new Error(`only a failed Meeting can be retried, and this one is ${meeting.state}`);
    if (meeting.transcript.segments.length === 0) throw new Error("this Meeting has no Transcript to summarise");
    await this.pipelineJob(id, "summary", context => this.runner.resummarise(id, meeting.transcript, context));
  }

  /**
   * Replaces a Meeting's Summary with a new one from its stored Transcript, using the current model. Participant names
   * live apart from the Summary, which holds labels, so a rename carries over.
   */
  async regenerateSummary(id: number): Promise<void> {
    this.assertNotDeleting(id);
    const meeting = this.deps.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    if (meeting.state !== "done" && meeting.state !== "failed") {
      throw new Error(`a Meeting that is ${meeting.state} cannot be summarised again yet`);
    }
    if (meeting.transcript.segments.length === 0) throw new Error("this Meeting has no Transcript to summarise");
    await this.pipelineJob(id, "summary", context => this.runner.resummarise(id, meeting.transcript, context));
  }

  /** Transcribes a failed Meeting again from its kept audio, without re-recording. */
  async retryTranscription(id: number): Promise<void> {
    this.assertNotDeleting(id);
    const meeting = this.deps.store.getMeeting(id);
    if (!meeting) throw new Error(`no such Meeting: ${id}`);
    if (meeting.state !== "failed") throw new Error(`only a failed Meeting can be retried, and this one is ${meeting.state}`);
    if (!meeting.audio) throw new Error("this Meeting has no audio to transcribe");
    for (const path of [meeting.audio.micPath, meeting.audio.systemPath]) {
      if (!existsSync(path)) throw new Error(`the audio is no longer there: ${path}`);
    }
    this.chatController.clear(id);
    await this.pipelineJob(id, "transcription-and-summary", context => this.runner.run(id, meeting.audio!, context));
  }

  getChatHistory(id: number): ChatRecord[] { return this.chatController.history(id); }

  getChatHistoryForDisplay(id: number): ChatRecord[] { return this.chatController.historyForDisplay(id); }

  sendQuestion(meetingId: number, requestId: string, question: string): ChatRecord {
    this.assertNotDeleting(meetingId);
    return this.chatController.send(meetingId, requestId, question);
  }

  cancelQuestion(meetingId: number, requestId: string): void { this.chatController.cancel(meetingId, requestId); }

  clearChat(meetingId: number): void { this.chatController.clear(meetingId); }

  onChatChanged(listener: (meetingId: number) => void): () => void { return this.chatController.onChange(listener); }

  getTranscriptRevision(id: number): string {
    const meeting = this.store.getMeeting(id);
    if (!meeting) throw new Error("This Meeting no longer exists");
    return transcriptRevision(meeting.transcript);
  }

  openReference(meetingId: number, reference: TranscriptReference): number[] {
    const meeting = this.store.getMeeting(meetingId);
    if (!meeting) throw new Error("This Meeting no longer exists");
    return resolveReference(meeting.transcript, reference).map(source => source.ref);
  }

  isChatAvailable(id: number): boolean {
    const meeting = this.store.getMeeting(id);
    if (this.stopping || this.deletingMeetings.has(id) || !this.deps.chat || !meeting || !meeting.transcript.segments.length || meeting.state === "recording") return false;
    const pipelineJobs = this.jobs.snapshot.filter(job => job.owner === `meeting:${id}`);
    if (pipelineJobs.some(job => job.kind !== "summary")) return false;
    return meeting.state !== "processing" || (pipelineJobs.length > 0 && pipelineJobs.every(job => job.kind === "summary"));
  }

  /** Resolves when managed AI work and its underlying native tasks have settled. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
    await this.jobs.idle();
  }

  start(): void {
    if (this.recoverOnStart) {
      this.recoverOnStart = false;
      // No native processing from a previous app process can survive this engine launch.
      for (const meeting of this.store.listMeetings()) {
        if ((meeting.state === "recording" || meeting.state === "processing")
          && !this.jobs.snapshot.some(job => job.owner === `meeting:${meeting.id}`)) {
          this.store.setMeetingState(meeting.id, "failed", "The app stopped before this Meeting finished processing. Retry from its saved audio or Transcript.");
        }
      }
    }
    this.stopping = false;
    this.setStatus("starting");
    this.deps.engine.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const jobsStopped = this.jobs.shutdown();
    // A Recording in progress is finished first, so its audio is kept rather than lost with the engine.
    this.stopRecording();
    await this.recordingSettled();
    this.deps.engine.send({ type: "shutdown" });
    await this.deps.engine.stop();
    await jobsStopped;
    await this.idle();
    this.setStatus("stopped");
  }

  private assertNotDeleting(id: number): void {
    if (this.deletingMeetings.has(id)) throw new Error("This Meeting is being deleted");
  }

  private pipelineJob(id: number, kind: string, task: (context: PipelineContext) => Promise<void>): Promise<void> {
    this.assertNotDeleting(id);
    this.store.setMeetingState(id, "processing");
    const queueId = randomUUID();
    const work = this.jobs.enqueue({ id: queueId, owner: `meeting:${id}`, kind }, signal => task({ signal,
      onStage: stage => this.jobs.updateKind(queueId, stage === "summarising" ? "summary" : "transcription"),
    })).catch(error => {
      if (this.store.getMeeting(id)) this.store.setMeetingState(id, "failed", error instanceof Error ? error.message : "AI work cancelled");
    });
    return this.track(work);
  }

  private track(job: Promise<void>): Promise<void> {
    this.inFlight.add(job);
    void job.then(() => this.inFlight.delete(job), () => this.inFlight.delete(job));
    return job;
  }

  private onDetected(app: string): void {
    // One Meeting at a time: ignore a second app while a Prompt is showing or a Recording is running.
    if (this._detectedMeeting || this.recordingMeetingId !== undefined) return;
    if (this.neverApps.some((a) => a.toLowerCase() === app.toLowerCase())) return;
    this._detectedMeeting = { state: "detected", app, detectedAt: new Date().toISOString() };
    // The start of the Meeting must survive a late answer, so audio is held in memory from now on.
    this.deps.engine.send({ type: "start_buffer", app });
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
    this.settleRecording();
  }

  /** Resolves once no Recording is waiting on the engine: its tracks arrived, or it failed. */
  private recordingSettled(): Promise<void> {
    if (this.recordingMeetingId === undefined) return Promise.resolve();
    return new Promise((resolve) => this.recordingSettledWaiters.push(resolve));
  }

  private settleRecording(): void {
    clearTimeout(this.stopTimer);
    for (const resolve of this.recordingSettledWaiters.splice(0)) resolve();
  }

  private notifyMeetings(): void {
    for (const listener of this.meetingsListeners) {
      try { listener(); } catch { /* A closed view cannot interrupt Meeting persistence. */ }
    }
  }

  private notifyingStore(store: Store): Store {
    const notify = () => this.notifyMeetings();
    return {
      ...store,
      createMeeting: (input) => {
        const id = store.createMeeting(input);
        notify();
        return id;
      },
      setMeetingState: (id, state, error) => {
        const previous = store.getMeeting(id);
        store.setMeetingState(id, state, error);
        if (previous?.state !== state || previous.error !== (error ?? null)) notify();
      },
      renameParticipant: (id, label, name) => {
        store.renameParticipant(id, label, name);
        notify();
      },
      deleteMeeting: (id) => {
        store.deleteMeeting(id);
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
