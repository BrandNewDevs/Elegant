import { randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { AIJobQueue } from "../pipeline/job-queue.js";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { MeetingChatGenerator } from "../pipeline/meeting-chat.js";
import type { ChatRecord, ChatStatus } from "../shared/meeting-chat.js";
import { canonicaliseParticipantMentions, displayParticipantMentions } from "./participants.js";

const activeStatus = (status: ChatStatus) => status === "queued" || status === "retrieving" || status === "generating";
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const meetingIdIsValid = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;
interface ActiveRequest { requestId: string; queueId: string; epoch: number }
export interface MeetingChatControllerOptions {
  store: Store;
  jobs: AIJobQueue;
  generate?: MeetingChatGenerator;
  isAvailable: (meetingId: number) => boolean;
}

/** Owns persisted request lifetimes; model output cannot recreate cleared or replaced history. */
export class MeetingChatController {
  private readonly epochs = new Map<number, number>();
  private readonly active = new Map<number, ActiveRequest>();
  private readonly listeners = new Set<(meetingId: number) => void>();

  constructor(private readonly options: MeetingChatControllerOptions) {
    options.store.interruptChats();
  }

  onChange(listener: (meetingId: number) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  history(meetingId: number): ChatRecord[] {
    if (!meetingIdIsValid(meetingId)) throw new Error("Invalid Meeting ID");
    return this.options.store.getChatHistory(meetingId);
  }

  historyForDisplay(meetingId: number): ChatRecord[] {
    const meeting = this.options.store.getMeeting(meetingId);
    if (!meeting) return [];
    return this.history(meetingId).map(record => ({ ...record,
      question: displayParticipantMentions(record.question, meeting.participants),
      answer: record.answer && { ...record.answer, text: displayParticipantMentions(record.answer.text, meeting.participants) },
    }));
  }

  send(meetingId: number, requestId: string, question: string): ChatRecord {
    if (!meetingIdIsValid(meetingId)) throw new Error("Invalid Meeting ID");
    if (!validId(requestId)) throw new Error("Request IDs must contain 1 to 128 letters, numbers, underscores or hyphens");
    if (typeof question !== "string" || !question.trim() || question.length > 2000) throw new Error("Questions must contain between 1 and 2000 characters");
    const { store, jobs, generate } = this.options;
    const meeting = store.getMeeting(meetingId);
    if (!meeting) throw new Error("This Meeting no longer exists");
    const canonical = canonicaliseParticipantMentions(question.trim(), meeting.participants);
    if (!canonical.trim() || canonical.length > 2000) throw new Error("The question is too long after resolving Participant names");
    const revision = transcriptRevision(meeting.transcript);
    const existing = store.getChatHistory(meetingId).find(record => record.id === requestId);
    if (existing) {
      if (existing.revision === revision && existing.question === canonical) return existing;
      throw new Error("This chat request ID is already in use");
    }
    if (!generate) throw new Error("Meeting chat is not configured");
    if (!this.options.isAvailable(meetingId)) throw new Error("This Meeting's Transcript is not ready for chat");
    if (this.active.has(meetingId) || store.getChatHistory(meetingId).some(record => activeStatus(record.status))) {
      throw new Error("Wait for this Meeting's current answer or cancel it before asking another question");
    }
    const record = store.createChatRequest({ id: requestId, meetingId, revision, question: canonical, createdAt: new Date().toISOString() });
    const epoch = this.epochs.get(meetingId) ?? 0;
    // A new attempt after Clear chat can queue behind cancelled native work with the same visible request ID.
    const queueId = `chat:${meetingId}:${requestId}:${randomUUID()}`;
    this.active.set(meetingId, { requestId, queueId, epoch });
    const current = () => {
      if ((this.epochs.get(meetingId) ?? 0) !== epoch || this.active.get(meetingId)?.queueId !== queueId) return false;
      const latest = store.getMeeting(meetingId);
      if (!latest || transcriptRevision(latest.transcript) !== revision) return false;
      const saved = store.getChatHistory(meetingId).find(saved => saved.id === requestId);
      return !!saved && saved.revision === revision && activeStatus(saved.status);
    };
    const update = (status: ChatStatus, error?: string) => {
      if (current() && store.updateChatRequest(requestId, revision, { status, ...(error ? { error } : {}) })) this.notify(meetingId);
    };
    const clearActive = () => {
      if (this.active.get(meetingId)?.queueId === queueId) this.active.delete(meetingId);
    };
    const work = jobs.enqueue({ id: queueId, owner: `chat:${meetingId}`, kind: "meeting-chat" }, async signal => {
      signal.throwIfAborted();
      if (!current()) return;
      if (!this.options.isAvailable(meetingId)) throw new Error("This Meeting's Transcript is not ready for chat");
      const history = store.getChatHistory(meetingId).filter(saved => saved.status === "completed" && saved.revision === revision && saved.answer)
        .slice(-4).map(saved => ({ question: saved.question, answer: saved.answer!.text }));
      update("retrieving");
      const result = await generate({ meetingId, question: canonical, history, expectedRevision: revision, signal,
        allowSummaryProcessing: store.getMeeting(meetingId)?.state === "processing",
        onStage: stage => { if (!signal.aborted) update(stage); },
      });
      signal.throwIfAborted();
      if (!current()) return;
      if (result.revision !== revision) throw new Error("The Meeting's Transcript changed before the answer completed");
      if (store.updateChatRequest(requestId, revision, { status: "completed", answer: result.answer, generation: result.generation })) this.notify(meetingId);
    });
    void work.then(clearActive, error => {
      update(error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
        error instanceof Error ? error.message : "The local model could not finish this answer. Retry the question.");
      clearActive();
    });
    this.notify(meetingId);
    return record;
  }

  cancel(meetingId: number, requestId: string): void {
    if (!meetingIdIsValid(meetingId) || !validId(requestId)) throw new Error("Invalid chat request");
    const record = this.options.store.getChatHistory(meetingId).find(saved => saved.id === requestId);
    if (record && activeStatus(record.status)) {
      this.options.store.updateChatRequest(requestId, record.revision, { status: "cancelled" });
      this.notify(meetingId);
    }
    const active = this.active.get(meetingId);
    if (active?.requestId === requestId) {
      this.options.jobs.cancel(active.queueId);
      this.active.delete(meetingId);
    }
  }

  clear(meetingId: number): void {
    if (!meetingIdIsValid(meetingId)) throw new Error("Invalid Meeting ID");
    this.options.jobs.cancelOwner(`chat:${meetingId}`);
    this.epochs.set(meetingId, (this.epochs.get(meetingId) ?? 0) + 1);
    this.active.delete(meetingId);
    this.options.store.clearChat(meetingId);
    this.notify(meetingId);
  }

  /** Refreshes derived availability or Participant display names without rewriting stored history. */
  refresh(meetingId: number): void { this.notify(meetingId); }

  private notify(meetingId: number): void {
    for (const listener of this.listeners) {
      try { listener(meetingId); } catch { /* A closed view cannot interrupt saved chat state. */ }
    }
  }
}
