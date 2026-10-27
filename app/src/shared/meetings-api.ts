import type { UpdateNotice } from "../core/update-check.js";
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
  setCheckForUpdates(check: boolean): void;
  /** Runs when a newer release was found, once the window is open to show it. */
  onUpdateAvailable(callback: (update: UpdateNotice) => void): () => void;
  /** Opens the release page of the update just announced in the default browser. */
  openRelease(): void;
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
