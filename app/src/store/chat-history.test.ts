import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { ChatGeneration } from "../shared/meeting-chat.js";
import { openStore, type Store } from "./store.js";

let dir: string;
const stores: Store[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chat-history-")); });
afterEach(() => { for (const store of stores.splice(0)) store.close(); rmSync(dir, { recursive: true, force: true }); });
function open(path = ":memory:") { const store = openStore(path); stores.push(store); return store; }
function close(store: Store) { stores.splice(stores.indexOf(store), 1); store.close(); }
function meeting(store: Store) {
  const meetingId = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-01T09:00:00.000Z" });
  const transcript = { segments: [{ start: 0, end: 10, speaker: "You", text: "I will review the guide on Friday." }] };
  store.saveTranscript(meetingId, transcript);
  store.setMeetingState(meetingId, "done");
  return { meetingId, revision: transcriptRevision(transcript) };
}
const createdAt = "2026-10-01T10:00:00.000Z";
const generation: ChatGeneration = { model: "synthetic-model", promptVersion: "chat-v1", elapsedMs: 20, calls: 1,
  retrievalMode: "full", exhaustive: true, retrievalCalls: 0, promptTokens: 100, outputTokens: 20 };
function complete(store: Store, id: string, revision: string) {
  return store.updateChatRequest(id, revision, { status: "completed", answer: { text: "You will review the guide on Friday.", refs: [0], sufficient: true }, generation });
}
function request(store: Store, id: string, target: ReturnType<typeof meeting>, question = "Who will review the guide?") {
  return store.createChatRequest({ id, ...target, question, createdAt });
}

describe("persistent Meeting chat through the Store", () => {
  it("keeps history isolated and ordered by insertion, even with reversed UUIDs and dates", () => {
    const store = open(), a = meeting(store), b = meeting(store);
    request(store, "z-last-lexically", a);
    store.createChatRequest({ id: "a-first-lexically", ...a, question: "When?", createdAt: "2026-09-01T10:00:00.000Z" });
    request(store, "other-meeting", b);
    expect(store.getChatHistory(a.meetingId).map(row => row.id)).toEqual(["z-last-lexically", "a-first-lexically"]);
    expect(store.getChatHistory(b.meetingId).map(row => row.id)).toEqual(["other-meeting"]);
    expect(store.getChatHistory(999)).toEqual([]);
  });

  it("makes a same-id request idempotent and rejects conflicting reuse without returning private content", () => {
    const store = open(), a = meeting(store), b = meeting(store);
    const original = request(store, "one", a);
    expect(request(store, "one", a)).toEqual(original);
    expect(store.getChatHistory(a.meetingId)).toHaveLength(1);
    expect(() => request(store, "one", b)).toThrow("This chat request id is already in use");
    expect(() => request(store, "one", a, "A different question")).toThrow("This chat request id is already in use");
    complete(store, "one", a.revision);
    expect(request(store, "one", a).status).toBe("completed");
  });

  it("rejects missing Meetings, stale revisions and invalid questions before inserting", () => {
    const store = open(), a = meeting(store);
    expect(() => request(store, "stale", { ...a, revision: "old" })).toThrow(/older Transcript/);
    expect(() => request(store, "missing", { ...a, meetingId: 999 })).toThrow(/no longer exists/);
    for (const question of ["  ", "x".repeat(2001)]) expect(() => request(store, "invalid", a, question)).toThrow(/Invalid chat request/);
    expect(store.getChatHistory(a.meetingId)).toEqual([]);
  });

  it("stores answer and generation metadata together, survives restart, and preserves terminal status", () => {
    const path = join(dir, "meetings.db"), first = open(path), a = meeting(first);
    request(first, "one", a);
    expect(first.updateChatRequest("one", a.revision, { status: "retrieving" })).toBe(true);
    expect(first.updateChatRequest("one", a.revision, { status: "generating" })).toBe(true);
    expect(complete(first, "one", a.revision)).toBe(true);
    const before = first.getChatHistory(a.meetingId);
    expect(before[0]).toMatchObject({ status: "completed", generation, answer: { refs: [0], sufficient: true } });
    close(first);
    const reopened = open(path);
    expect(reopened.getChatHistory(a.meetingId)).toEqual(before);
    expect(reopened.updateChatRequest("one", a.revision, { status: "failed", error: "late" })).toBe(false);
    expect(reopened.getChatHistory(a.meetingId)).toEqual(before);
  });

  it("recovers active requests only when explicitly interrupted and leaves completed or failed rows alone", () => {
    const path = join(dir, "meetings.db"), first = open(path), a = meeting(first);
    for (const status of ["queued", "retrieving", "generating", "failed", "cancelled", "completed"] as const) {
      request(first, status, a);
      if (status === "completed") complete(first, status, a.revision);
      else if (status !== "queued") first.updateChatRequest(status, a.revision, { status });
    }
    close(first);
    const reopened = open(path);
    expect(reopened.getChatHistory(a.meetingId).slice(0, 3).map(row => row.status)).toEqual(["queued", "retrieving", "generating"]);
    reopened.interruptChats();
    expect(reopened.getChatHistory(a.meetingId).map(row => row.status)).toEqual(["interrupted", "interrupted", "interrupted", "failed", "cancelled", "completed"]);
    expect(reopened.getChatHistory(a.meetingId)[0]).toMatchObject({ answer: null, generation: null, error: expect.stringContaining("Retry") });
    expect(complete(reopened, "queued", a.revision)).toBe(false);
  });

  it("rejects invalid references and incomplete completion atomically", () => {
    const store = open(), a = meeting(store); request(store, "one", a);
    for (const refs of [[], [1], [-1], [0, 0], [0.5]]) {
      expect(() => store.updateChatRequest("one", a.revision, { status: "completed", answer: { text: "Answer", refs, sufficient: true }, generation })).toThrow(/evidence/);
    }
    expect(() => store.updateChatRequest("one", a.revision, { status: "completed" })).toThrow(/answer and generation/);
    expect(() => store.updateChatRequest("one", a.revision, { status: "completed", answer: { text: "Answer", refs: [0], sufficient: true }, generation: { ...generation, elapsedMs: -1 } })).toThrow(/metadata/);
    expect(() => store.updateChatRequest("one", a.revision, { status: "generating", answer: { text: "partial", refs: [0], sufficient: true } })).toThrow(/Only completed/);
    expect(store.getChatHistory(a.meetingId)[0]).toMatchObject({ status: "queued", answer: null, generation: null });
    expect(store.updateChatRequest("one", "stale", { status: "completed" })).toBe(false);
  });

  it("saves an evidence limitation with no source references", () => {
    const store = open(), a = meeting(store); request(store, "absent", a, "What is the budget?");
    expect(() => store.updateChatRequest("absent", a.revision, { status: "completed", answer: { text: "Not established.", refs: [0], sufficient: false }, generation })).toThrow(/evidence/);
    expect(store.updateChatRequest("absent", a.revision, { status: "completed", answer: { text: "Not established in the available Transcript.", refs: [], sufficient: false }, generation })).toBe(true);
    expect(store.getChatHistory(a.meetingId)[0]?.answer?.sufficient).toBe(false);
  });

  it("never resurrects cancelled, failed, interrupted or completed requests", () => {
    const store = open(), a = meeting(store);
    for (const status of ["cancelled", "failed", "interrupted", "completed"] as const) {
      request(store, status, a);
      if (status === "completed") complete(store, status, a.revision);
      else store.updateChatRequest(status, a.revision, { status });
      expect(complete(store, status, a.revision)).toBe(false);
      expect(store.updateChatRequest(status, a.revision, { status: "generating" })).toBe(false);
    }
  });

  it("clears only one Meeting and refuses late updates after clear, deletion or Transcript replacement", () => {
    const store = open(), a = meeting(store), b = meeting(store);
    request(store, "a", a); request(store, "b", b);
    store.clearChat(a.meetingId);
    expect(complete(store, "a", a.revision)).toBe(false);
    expect(store.getChatHistory(a.meetingId)).toEqual([]);
    expect(store.getChatHistory(b.meetingId)).toHaveLength(1);
    store.saveTranscript(b.meetingId, { segments: [{ start: 0, end: 1, speaker: "You", text: "Changed Transcript." }] });
    expect(complete(store, "b", b.revision)).toBe(false);
    expect(store.getChatHistory(b.meetingId)).toEqual([]);
    const current = { meetingId: b.meetingId, revision: transcriptRevision(store.getMeeting(b.meetingId)!.transcript) };
    request(store, "deleted", current);
    store.deleteMeeting(b.meetingId);
    expect(complete(store, "deleted", current.revision)).toBe(false);
    expect(store.getChatHistory(b.meetingId)).toEqual([]);
  });

  it("preserves chat when a Participant is renamed or a Summary is regenerated", () => {
    const store = open(), a = meeting(store); request(store, "one", a); complete(store, "one", a.revision);
    const before = store.getChatHistory(a.meetingId);
    store.renameParticipant(a.meetingId, "You", "Alex");
    store.saveSummary(a.meetingId, { tldr: "Review the guide.", participants: [{ speaker: "You", said: ["Review Friday."] }] });
    expect(store.getChatHistory(a.meetingId)).toEqual(before);
  });
});
