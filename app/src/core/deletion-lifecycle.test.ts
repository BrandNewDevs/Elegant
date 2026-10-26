import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingChatGenerator } from "../pipeline/meeting-chat.js";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import { AppCore } from "./app-core.js";

const contexts: { core: AppCore; store: ReturnType<typeof openStore>; directory: string }[] = [];
function context(generate?: MeetingChatGenerator) {
  const directory = mkdtempSync(join(tmpdir(), "deletion-lifecycle-"));
  const tracks = { micPath: join(directory, "mic.wav"), systemPath: join(directory, "system.wav") };
  writeFileSync(tracks.micPath, "synthetic"); writeFileSync(tracks.systemPath, "synthetic");
  const store = openStore(":memory:");
  const engine = new FakeEngine();
  const chat = vi.fn<MeetingChatGenerator>(generate ?? (async input => ({ revision: input.expectedRevision,
    answer: { text: "Ship the walking skeleton first.", refs: [0], sufficient: true },
    generation: { model: "synthetic", promptVersion: "test", elapsedMs: 1, calls: 1, retrievalMode: "full", retrievalCalls: 0, exhaustive: true } })));
  const pipeline = { ...fakePipeline(), summarise: vi.fn(fakePipeline().summarise), transcribe: vi.fn(fakePipeline().transcribe) };
  const core = new AppCore({ store, engine, pipeline, chat });
  core.start(); engine.emit({ type: "ready", version: "0.1.0" });
  const id = store.createMeeting({ app: "Synthetic Meeting", startedAt: "2026-10-27T12:00:00Z" });
  store.saveTranscript(id, fixtureTranscript); store.saveSummary(id, fixtureSummary); store.saveAudio(id, tracks); store.setMeetingState(id, "done");
  const ctx = { core, store, directory, tracks, id, chat, pipeline };
  contexts.push(ctx);
  return ctx;
}
afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.core.stop(); ctx.store.close(); rmSync(ctx.directory, { recursive: true, force: true });
  }
});

describe("Meeting deletion through AppCore", () => {
  it("blocks new questions, regeneration, retries and duplicate deletion before audio removal yields", async () => {
    const ctx = context();
    const deleting = ctx.core.deleteMeeting(ctx.id);
    expect(ctx.core.isChatAvailable(ctx.id)).toBe(false);
    expect(() => ctx.core.sendQuestion(ctx.id, "raced-question", "What was decided?")).toThrow(/being deleted/);
    const blocked = [ctx.core.regenerateSummary(ctx.id), ctx.core.retrySummary(ctx.id), ctx.core.retryTranscription(ctx.id), ctx.core.deleteMeeting(ctx.id)]
      .map(work => expect(work).rejects.toThrow(/being deleted/));
    expect(ctx.core.jobs.snapshot).toEqual([]);
    expect(ctx.core.getChatHistory(ctx.id)).toEqual([]);
    await Promise.all([...blocked, deleting]);
    await ctx.core.idle();
    expect(ctx.store.getMeeting(ctx.id)).toBeUndefined();
    expect(existsSync(ctx.tracks.micPath)).toBe(false);
    expect(existsSync(ctx.tracks.systemPath)).toBe(false);
    expect(ctx.chat).not.toHaveBeenCalled();
    expect(ctx.pipeline.summarise).not.toHaveBeenCalled();
    expect(ctx.pipeline.transcribe).not.toHaveBeenCalled();
    expect(ctx.core.jobs.snapshot).toEqual([]);
  });

  it("cancels an existing active answer and does not admit a replacement during deletion", async () => {
    const ctx = context(input => new Promise((_resolve, reject) => {
      input.signal!.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), { once: true });
    }));
    ctx.core.sendQuestion(ctx.id, "existing", "What was decided?");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ctx.chat).toHaveBeenCalledTimes(1);
    const deleting = ctx.core.deleteMeeting(ctx.id);
    expect(() => ctx.core.sendQuestion(ctx.id, "replacement", "Who agreed?")).toThrow(/being deleted/);
    await deleting; await ctx.core.idle();
    expect(ctx.core.jobs.snapshot).toEqual([]);
    expect(ctx.core.getChatHistory(ctx.id)).toEqual([]);
    expect(ctx.chat).toHaveBeenCalledTimes(1);
  });

  it("restores availability and retryability after audio removal fails", async () => {
    const ctx = context();
    rmSync(ctx.tracks.micPath); mkdirSync(ctx.tracks.micPath);
    const availability: boolean[] = [];
    ctx.core.onChatChanged(id => { if (id === ctx.id) availability.push(ctx.core.isChatAvailable(id)); });
    await expect(ctx.core.deleteMeeting(ctx.id)).rejects.toThrow();
    expect(ctx.store.getMeeting(ctx.id)).toBeDefined();
    expect(ctx.core.isChatAvailable(ctx.id)).toBe(true);
    expect(availability).toContain(false); expect(availability.at(-1)).toBe(true);
    ctx.core.sendQuestion(ctx.id, "after-failure", "What was decided?");
    await ctx.core.idle();
    expect(ctx.core.getChatHistory(ctx.id)[0]?.status).toBe("completed");
    await ctx.core.regenerateSummary(ctx.id);
    expect(ctx.pipeline.summarise).toHaveBeenCalledTimes(1);
    rmSync(ctx.tracks.micPath, { recursive: true }); writeFileSync(ctx.tracks.micPath, "synthetic");
    await ctx.core.deleteMeeting(ctx.id);
    expect(ctx.store.getMeeting(ctx.id)).toBeUndefined();
  });
});
