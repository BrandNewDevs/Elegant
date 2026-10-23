import type { Engine } from "../engine/protocol.js";
import type { PipelineStages } from "../pipeline/pipeline.js";
import { PipelineRunner } from "../pipeline/runner.js";
import type { Meeting, MeetingListItem, Store } from "../store/store.js";

export type EngineStatus = "starting" | "running" | "stopped" | "crashed";

export interface AppCoreDeps {
  engine: Engine;
  store: Store;
  pipeline: PipelineStages;
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

  private readonly store: Store;

  constructor(private readonly deps: AppCoreDeps) {
    this.store = this.notifyingStore(deps.store);
    this.runner = new PipelineRunner(deps.pipeline, this.store);
    deps.engine.onEvent((event) => {
      switch (event.type) {
        case "ready":
          this.setStatus("running");
          break;
        case "recording_started":
          this.abandonRecording("the recording was interrupted by a new one");
          this.recordingMeetingId = this.store.createMeeting({ app: event.app, startedAt: event.startedAt });
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

  /** A Recording that can no longer finish is marked failed, so no Meeting is left stuck as recording. */
  private abandonRecording(reason: string): void {
    const id = this.recordingMeetingId;
    if (id === undefined) return;
    this.recordingMeetingId = undefined;
    this.store.setMeetingState(id, "failed", reason);
  }

  private notifyingStore(store: Store): Store {
    const notify = () => {
      for (const l of this.meetingsListeners) l();
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

  private setStatus(status: EngineStatus): void {
    if (status === this._status) return;
    this._status = status;
    for (const l of this.statusListeners) l(status);
  }
}
