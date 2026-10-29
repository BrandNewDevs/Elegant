import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCore } from "./app-core.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import { openStore, type Store } from "../store/store.js";
import type { MeetingChatGenerator } from "../pipeline/meeting-chat.js";
import type { PipelineStages, Summary, Transcript } from "../pipeline/pipeline.js";
import { transcriptRevision } from "../pipeline/evidence.js";

type ChatInput = Parameters<MeetingChatGenerator>[0];
type ChatResult = Awaited<ReturnType<MeetingChatGenerator>>;
const revision = transcriptRevision(fixtureTranscript);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const finishers: (() => void)[] = [];
const directories: string[] = [];
interface TestContext { store: Store; engine: FakeEngine; core: AppCore; saved: () => number; closed: boolean }
const contexts: TestContext[] = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  finishers.push(() => resolve(fallback));
  return { promise, resolve };
}
function answer(expectedRevision: string, text = "Speaker 1 agreed to the walking skeleton."): ChatResult {
  return { revision: expectedRevision, answer: { text, refs: [1], sufficient: true },
    generation: { model: "local:test", promptVersion: "chat:test", elapsedMs: 1, calls: 1,
      retrievalMode: "full", exhaustive: true, retrievalCalls: 0 } };
}
function directory() {
  const path = mkdtempSync(join(tmpdir(), "meeting-chat-test-"));
  directories.push(path);
  return path;
}
function context(generate: MeetingChatGenerator = async input => answer(input.expectedRevision), pipeline: PipelineStages = fakePipeline(), path = ":memory:"): TestContext {
  const store = openStore(path);
  const engine = new FakeEngine();
  const core = new AppCore({ store, engine, pipeline, chat: generate });
  core.start(); engine.emit({ type: "ready", version: "0.1.0" });
  const saved = () => {
    const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27T12:00:00Z" });
    store.saveTranscript(id, fixtureTranscript); store.saveSummary(id, fixtureSummary); store.setMeetingState(id, "done");
    return id;
  };
  const ctx = { store, engine, core, saved, closed: false };
  contexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const finish of finishers.splice(0)) finish();
  for (const ctx of contexts.splice(0)) {
    if (ctx.closed) continue;
    await ctx.core.stop();
    ctx.store.close(); ctx.closed = true;
  }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Meeting chat through AppCore", () => {
  it("returns queued work immediately, persists completed answers and isolates Meetings", async () => {
    const model = deferred(answer(revision));
    const generate = vi.fn<MeetingChatGenerator>(() => model.promise);
    const ctx = context(generate);
    const first = ctx.saved(), second = ctx.saved();
    const record = ctx.core.sendQuestion(first, "request_1", "What was agreed?");
    expect(record).toMatchObject({ id: "request_1", meetingId: first, status: "queued", answer: null });
    expect(generate).not.toHaveBeenCalled();
    await turn();
    expect(ctx.core.getChatHistory(first)[0]?.status).toBe("retrieving");
    expect(ctx.core.getChatHistory(second)).toEqual([]);
    model.resolve(answer(revision));
    await ctx.core.idle();
    expect(ctx.core.getChatHistory(first)[0]).toMatchObject({ status: "completed", answer: answer(revision).answer });
  });

  it("accepts questions after a failed Summary when a completed Transcript exists", async () => {
    const ctx = context();
    const id = ctx.saved();
    ctx.store.saveTranscript(id, fixtureTranscript);
    ctx.store.setMeetingState(id, "failed", "Ollama was unavailable during the Summary");
    expect(ctx.store.getMeeting(id)?.summary).toBeNull();
    expect(ctx.core.isChatAvailable(id)).toBe(true);
    ctx.core.sendQuestion(id, "failed_summary", "What happened?");
    await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]?.status).toBe("completed");
  });

  it("queues chat during Summary generation without overlapping AI work", async () => {
    const summary = deferred<Summary>(fixtureSummary);
    const generate = vi.fn<MeetingChatGenerator>(async input => answer(input.expectedRevision));
    const ctx = context(generate, { ...fakePipeline(), summarise: () => summary.promise });
    const id = ctx.saved();
    const regenerating = ctx.core.regenerateSummary(id);
    await turn();
    expect(ctx.store.getMeeting(id)?.state).toBe("processing");
    expect(ctx.core.isChatAvailable(id)).toBe(true);
    expect(ctx.core.sendQuestion(id, "summary_wait", "What happened?").status).toBe("queued");
    expect(generate).not.toHaveBeenCalled();
    summary.resolve(fixtureSummary);
    await regenerating; await ctx.core.idle();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(ctx.core.getChatHistory(id)[0]?.status).toBe("completed");
  });

  it("blocks queued and active transcription, then exposes chat once the Transcript is saved", async () => {
    const transcription = deferred<Transcript>(fixtureTranscript);
    const summary = deferred<Summary>(fixtureSummary);
    const blocker = deferred<void>(undefined);
    const ctx = context(undefined, { transcribe: () => transcription.promise, summarise: () => summary.promise });
    const id = ctx.saved();
    const audioDirectory = directory();
    const audio = { micPath: join(audioDirectory, "mic.wav"), systemPath: join(audioDirectory, "system.wav") };
    writeFileSync(audio.micPath, "synthetic"); writeFileSync(audio.systemPath, "synthetic");
    ctx.store.saveAudio(id, audio); ctx.store.setMeetingState(id, "failed");
    const holding = ctx.core.jobs.enqueue({ id: "hold", owner: "setup", kind: "speech-model-preparation" }, () => blocker.promise);
    const transcribing = ctx.core.retryTranscription(id);
    expect(ctx.core.isChatAvailable(id)).toBe(false);
    expect(() => ctx.core.sendQuestion(id, "too_early", "What happened?")).toThrow("not ready");
    blocker.resolve(); await holding; await turn();
    expect(ctx.core.jobs.snapshot[0]?.kind).toBe("transcription");
    expect(ctx.core.isChatAvailable(id)).toBe(false);
    transcription.resolve(fixtureTranscript); await turn();
    expect(ctx.core.jobs.snapshot[0]?.kind).toBe("summary");
    expect(ctx.core.isChatAvailable(id)).toBe(true);
    ctx.core.sendQuestion(id, "after_transcript", "What happened?");
    summary.resolve(fixtureSummary);
    await transcribing; await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]?.status).toBe("completed");
  });

  it("sends only the latest four completed exchanges while retaining full history", async () => {
    const histories: ChatInput["history"][] = [];
    const ctx = context(async input => { histories.push(input.history); return answer(input.expectedRevision); });
    const id = ctx.saved();
    for (let index = 0; index < 6; index++) {
      ctx.core.sendQuestion(id, `history_${index}`, `Question ${index}?`);
      await ctx.core.idle();
    }
    expect(ctx.core.getChatHistory(id)).toHaveLength(6);
    expect(histories[0]).toEqual([]);
    expect(histories[5]?.map(pair => pair.question)).toEqual(["Question 1?", "Question 2?", "Question 3?", "Question 4?"]);
    expect(histories[5]?.every(pair => typeof pair.answer === "string")).toBe(true);
  });

  it("makes duplicate submissions idempotent and rejects conflicting or concurrent questions", async () => {
    const model = deferred(answer(revision));
    const generate = vi.fn<MeetingChatGenerator>(() => model.promise);
    const ctx = context(generate);
    const id = ctx.saved();
    const first = ctx.core.sendQuestion(id, "duplicate", "What happened?");
    expect(ctx.core.sendQuestion(id, "duplicate", "What happened?")).toEqual(first);
    expect(() => ctx.core.sendQuestion(id, "duplicate", "A different question?")).toThrow("already in use");
    expect(() => ctx.core.sendQuestion(id, "another", "What happened?")).toThrow("current answer");
    await turn();
    expect(generate).toHaveBeenCalledTimes(1);
    model.resolve(answer(revision)); await ctx.core.idle();
    expect(ctx.core.sendQuestion(id, "duplicate", "What happened?").status).toBe("completed");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("records generation failure and permits a new request to retry", async () => {
    let calls = 0;
    const ctx = context(async input => {
      if (calls++ === 0) throw new Error("Start Ollama and retry.");
      return answer(input.expectedRevision);
    });
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "failure", "What happened?"); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ status: "failed", answer: null, error: "Start Ollama and retry." });
    ctx.core.sendQuestion(id, "retry", "What happened?"); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id).map(record => record.status)).toEqual(["failed", "completed"]);
  });

  it("keeps cancellation distinct and cannot save an ignored-abort late answer", async () => {
    const model = deferred(answer(revision, "Late answer"));
    const ctx = context(() => model.promise);
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "cancel", "What happened?"); await turn();
    ctx.core.cancelQuestion(id, "cancel");
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ status: "cancelled", answer: null });
    model.resolve(answer(revision, "Late answer")); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ status: "cancelled", answer: null });
  });

  it("clear followed by immediate request ID reuse cannot resurrect or overwrite old output", async () => {
    const old = deferred(answer(revision, "Old answer"));
    let calls = 0;
    const ctx = context(async input => ++calls === 1 ? old.promise : answer(input.expectedRevision, "New answer"));
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "reuse", "Old question?"); await turn();
    ctx.core.clearChat(id);
    expect(ctx.core.getChatHistory(id)).toEqual([]);
    expect(ctx.core.sendQuestion(id, "reuse", "New question?").status).toBe("queued");
    expect(ctx.core.jobs.snapshot).toHaveLength(2);
    old.resolve(answer(revision, "Old answer")); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)).toHaveLength(1);
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ question: "New question?", status: "completed", answer: { text: "New answer" } });
  });

  it("deletion cancels chat before removing the Meeting and ignores late output", async () => {
    const model = deferred(answer(revision));
    const ctx = context(() => model.promise);
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "delete", "What happened?"); await turn();
    await ctx.core.deleteMeeting(id);
    model.resolve(answer(revision)); await ctx.core.idle();
    expect(ctx.core.getMeeting(id)).toBeUndefined();
    expect(ctx.core.getChatHistory(id)).toEqual([]);
  });

  it("retranscription clears chat before queueing even when the replacement revision is identical", async () => {
    const old = deferred(answer(revision));
    const ctx = context(() => old.promise);
    const id = ctx.saved();
    const audioDirectory = directory();
    const audio = { micPath: join(audioDirectory, "mic.wav"), systemPath: join(audioDirectory, "system.wav") };
    writeFileSync(audio.micPath, "synthetic"); writeFileSync(audio.systemPath, "synthetic");
    ctx.core.sendQuestion(id, "replace", "What happened?"); await turn();
    ctx.store.saveAudio(id, audio); ctx.store.setMeetingState(id, "failed");
    const retrying = ctx.core.retryTranscription(id);
    expect(ctx.core.getChatHistory(id)).toEqual([]);
    old.resolve(answer(revision)); await retrying; await ctx.core.idle();
    expect(ctx.core.getTranscriptRevision(id)).toBe(revision);
    expect(ctx.core.getChatHistory(id)).toEqual([]);
  });

  it("preserves canonical history across renames and Summary regeneration", async () => {
    const questions: string[] = [];
    const ctx = context(async input => { questions.push(input.question); return answer(input.expectedRevision); });
    const id = ctx.saved();
    ctx.core.renameParticipant(id, "Speaker 1", "Alice");
    ctx.core.sendQuestion(id, "rename", "What did alice agree to?"); await ctx.core.idle();
    expect(questions).toEqual(["What did Speaker 1 agree to?"]);
    expect(ctx.core.getChatHistory(id)[0]?.question).toBe("What did Speaker 1 agree to?");
    ctx.core.renameParticipant(id, "Speaker 1", "Beth");
    expect(ctx.core.getChatHistoryForDisplay(id)[0]).toMatchObject({ question: "What did Beth agree to?", answer: { text: "Beth agreed to the walking skeleton." } });
    await ctx.core.regenerateSummary(id);
    expect(ctx.core.getChatHistory(id)[0]?.status).toBe("completed");
    expect(ctx.core.getTranscriptRevision(id)).toBe(revision);
    expect(ctx.core.getMeetingForDisplay(id)?.transcript.segments[1]?.text).toBe(fixtureTranscript.segments[1]!.text);
  });

  it("uses the current global own name for chat while keeping stored questions and answers canonical", async () => {
    const generatedQuestions: string[] = [];
    const ctx = context(async input => {
      generatedQuestions.push(input.question);
      const result = answer(input.expectedRevision, "You proposed the walking skeleton.");
      result.answer.refs = [0];
      return result;
    });
    const id = ctx.saved();
    ctx.store.setSetting("userName", "Alex");
    ctx.core.sendQuestion(id, "own_name", "What did Alex propose?"); await ctx.core.idle();
    expect(generatedQuestions).toEqual(["What did You propose?"]);
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ question: "What did You propose?", answer: { text: "You proposed the walking skeleton." } });
    expect(ctx.core.getChatHistoryForDisplay(id)[0]).toMatchObject({ question: "What did Alex propose?", answer: { text: "Alex proposed the walking skeleton." } });
    ctx.store.setSetting("userName", "Jordan");
    expect(ctx.core.getChatHistoryForDisplay(id)[0]).toMatchObject({ question: "What did Jordan propose?", answer: { text: "Jordan proposed the walking skeleton." } });
    expect(ctx.core.getMeetingForDisplay(id)?.transcript.segments[0]?.speaker).toBe("Jordan");
    expect(ctx.core.getMeeting(id)?.transcript.segments[0]?.speaker).toBe("You");
    expect(ctx.core.getChatHistory(id)[0]?.question).toBe("What did You propose?");
    expect(ctx.core.getTranscriptRevision(id)).toBe(revision);
  });

  it("gives a per-Meeting own-name override precedence over global Settings in chat", async () => {
    const ctx = context(async input => {
      const result = answer(input.expectedRevision, "You proposed the walking skeleton.");
      result.answer.refs = [0];
      return result;
    });
    const id = ctx.saved();
    ctx.store.setSetting("userName", "Alex");
    ctx.core.renameParticipant(id, "You", "Lead");
    ctx.core.sendQuestion(id, "own_override", "What did Lead propose?"); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]?.question).toBe("What did You propose?");
    ctx.store.setSetting("userName", "Jordan");
    expect(ctx.core.getChatHistoryForDisplay(id)[0]).toMatchObject({ question: "What did Lead propose?", answer: { text: "Lead proposed the walking skeleton." } });
    expect(ctx.core.getMeetingForDisplay(id)?.transcript.segments[0]?.speaker).toBe("Lead");
    ctx.core.renameParticipant(id, "You", "");
    expect(ctx.core.getChatHistoryForDisplay(id)[0]).toMatchObject({ question: "What did Jordan propose?", answer: { text: "Jordan proposed the walking skeleton." } });
  });

  it("rejects a global own name that is ambiguous with another Participant", () => {
    const ctx = context();
    const id = ctx.saved();
    ctx.store.setSetting("userName", "Alex");
    ctx.store.renameParticipant(id, "Speaker 1", "alex");
    expect(() => ctx.core.sendQuestion(id, "own_ambiguous", "What did Alex say?")).toThrow("ambiguous");
    expect(ctx.core.getChatHistory(id)).toEqual([]);
  });

  it("resolves escaped whole names without substrings and rejects ambiguous aliases", async () => {
    const ctx = context();
    const id = ctx.saved();
    ctx.core.renameParticipant(id, "Speaker 1", "A+B");
    ctx.core.sendQuestion(id, "escaped", "What did a+b say about A+Beta?"); await ctx.core.idle();
    expect(ctx.core.getChatHistory(id)[0]?.question).toBe("What did Speaker 1 say about A+Beta?");
    ctx.core.renameParticipant(id, "You", "Alex"); ctx.store.renameParticipant(id, "Speaker 1", "alex");
    expect(() => ctx.core.sendQuestion(id, "ambiguous", "What did Alex say?")).toThrow("ambiguous");
  });

  it("restores history on restart and marks unfinished requests interrupted", async () => {
    const path = join(directory(), "meetings.db");
    const ctx = context(undefined, undefined, path);
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "done", "What happened?"); await ctx.core.idle();
    ctx.store.createChatRequest({ id: "unfinished", meetingId: id, revision, question: "What next?", createdAt: new Date().toISOString() });
    ctx.store.setMeetingState(id, "processing");
    await ctx.core.stop(); ctx.store.close(); ctx.closed = true;
    const restarted = context(undefined, undefined, path);
    expect(restarted.core.getChatHistory(id).map(record => record.status)).toEqual(["completed", "interrupted"]);
    expect(restarted.core.getMeeting(id)?.state).toBe("failed");
    expect(restarted.core.isChatAvailable(id)).toBe(true);
    restarted.core.sendQuestion(id, "after_restart", "What next?"); await restarted.core.idle();
    expect(restarted.core.getChatHistory(id).at(-1)?.status).toBe("completed");
  });

  it("validates reference revisions and IDs against the original Transcript after naming", () => {
    const ctx = context();
    const id = ctx.saved();
    ctx.core.renameParticipant(id, "Speaker 1", "Alice");
    expect(ctx.core.openReference(id, { revision, refs: [1] })).toEqual([1]);
    expect(() => ctx.core.openReference(id, { revision, refs: [999] })).toThrow("Unknown");
    ctx.store.saveTranscript(id, { segments: [{ start: 0, end: 1, speaker: "You", text: "Different discussion" }] });
    expect(() => ctx.core.openReference(id, { revision, refs: [1] })).toThrow("older Transcript");
    expect(() => ctx.core.sendQuestion(id, "bad/id", "Question?")).toThrow("Request IDs");
    expect(() => ctx.core.sendQuestion(id, "too_long", "x".repeat(2001))).toThrow("2000");
    expect(() => ctx.core.sendQuestion(0, "invalid_meeting", "Question?")).toThrow("Meeting ID");
  });

  it("cancels active chat and drains model work before shutdown returns", async () => {
    let signal: AbortSignal | undefined;
    const ctx = context(input => new Promise<ChatResult>((_resolve, reject) => {
      const currentSignal = input.signal;
      if (!currentSignal) throw new Error("The queue must pass cancellation to chat");
      signal = currentSignal;
      currentSignal.addEventListener("abort", () => reject(currentSignal.reason), { once: true });
    }));
    const id = ctx.saved();
    ctx.core.sendQuestion(id, "shutdown", "What happened?"); await turn();
    await ctx.core.stop();
    expect(signal?.aborted).toBe(true);
    expect(ctx.core.jobs.snapshot).toEqual([]);
    expect(ctx.core.getChatHistory(id)[0]).toMatchObject({ status: "cancelled", answer: null });
    expect(ctx.store.listMeetings()).toHaveLength(1);
  });

  it("publishes persisted progress and supports unsubscribing a closed view", async () => {
    const ctx = context(async input => { input.onStage?.("generating"); return answer(input.expectedRevision); });
    const id = ctx.saved();
    const observer = vi.fn();
    const unsubscribe = ctx.core.onChatChanged(observer);
    ctx.core.onChatChanged(() => { throw new Error("closed view"); });
    ctx.core.sendQuestion(id, "observed", "What happened?"); await ctx.core.idle();
    expect(observer).toHaveBeenCalledWith(id);
    const count = observer.mock.calls.length;
    unsubscribe(); ctx.core.clearChat(id);
    expect(observer).toHaveBeenCalledTimes(count);
  });
});
