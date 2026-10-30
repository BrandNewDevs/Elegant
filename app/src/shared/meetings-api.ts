import type { RestartResult, UpdateState } from "../core/updater.js";
import type { ModelChange } from "../setup/setup.js";
import type { ModelFile, ModelKind } from "./model-kinds.js";
import type { Appearance } from "./appearance.js";
import type { MeetingsViewState } from "./meetings-view-state.js";

export interface SendQuestionInput { meetingId: number; requestId: string; question: string }
export interface CancelQuestionInput { meetingId: number; requestId: string }
export interface OpenReferenceInput { meetingId: number; revision: string; refs: number[] }
export interface CancelJobInput { meetingId: number; jobId: string }

/** The sandboxed Meetings page can request only these application operations. */
export interface MeetingsApi {
  ready(): void;
  onState(callback: (state: MeetingsViewState) => void): () => void;
  settings(open: boolean): void;
  setShowInDock(show: boolean): void;
  setAppearance(appearance: Appearance): void;
  /** Chooses the Ollama model that writes Summaries and answers chat. */
  setSummaryModel(model: string): void;
  /** The speech and speaker models on disk, with their sizes. */
  modelFiles(): Promise<ModelFile[]>;
  /** Deletes one kind of model; refused, with the reason, while it is in use. */
  removeModel(kind: ModelKind): Promise<ModelChange>;
  /** Deletes one kind of model and downloads it again; progress shows as the models' download. */
  redownloadModel(kind: ModelKind): Promise<ModelChange>;
  /** The models pulled into Ollama, empty when it is not running. */
  installedModels(): Promise<string[]>;
  setKeepAudio(keep: boolean): void;
  setCheckForUpdates(check: boolean): void;
  /** Runs as an update downloads, is ready or fails, once the window is open to show it. */
  onUpdate(callback: (update: Exclude<UpdateState, { status: "idle" }>) => void): () => void;
  /** Quits and installs the ready update, unless a Recording or AI work is going on; says why when it does not. */
  restartForUpdate(): Promise<RestartResult>;
  /** Opens the release page of the update that failed in the default browser. */
  openRelease(): void;
  /** Stops the Recording in progress, as the menu bar's Stop does. */
  stopRecording(): void;
  select(id: number): void;
  search(query: string): void;
  rename(payload: { meetingId: number; label: string; name: string }): void;
  export(id: number): void;
  regenerate(id: number): Promise<void>;
  delete(id: number): Promise<void>;
  sendQuestion(payload: SendQuestionInput): Promise<void>;
  cancelQuestion(payload: CancelQuestionInput): Promise<void>;
  clearChat(meetingId: number): Promise<void>;
  openReference(payload: OpenReferenceInput): Promise<number[]>;
  cancelJob(payload: CancelJobInput): Promise<void>;
}
