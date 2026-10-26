import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCore } from "./app-core.js";
import { openStore, type Store } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import type { PipelineStages, Summary } from "../pipeline/pipeline.js";
import { AIJobQueue } from "../pipeline/job-queue.js";
import { Setup } from "../setup/setup.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function context(summarise: PipelineStages["summarise"]) {
  const store = openStore(":memory:");
  stores.push(store);
  const engine = new FakeEngine();
  const jobs = new AIJobQueue();
  const core = new AppCore({ engine, store, jobs, pipeline: { ...fakePipeline(), summarise }, detection: { debounceMs: 0 } });
  core.start();
  engine.emit({ type: "ready", version: "0.1.0" });
  const saved = () => {
    const id = store.createMeeting({ app: "zoom.us", startedAt: "2026-10-27T10:00:00Z" });
    store.saveTranscript(id, fixtureTranscript);
    store.saveSummary(id, fixtureSummary);
    store.setMeetingState(id, "done");
    return id;
  };
  return { core, store, engine, jobs, saved };
}

const replacement: Summary = { tldr: "A replacement Summary.", participants: [{ speaker: "You", said: ["A replacement point."] }] };

describe("AI lifecycle through AppCore", () => {
  it("serializes regeneration across Meetings while exposing the queued work", async () => {
    const first = deferred<Summary>();
    let calls = 0;
    const ctx = context(async () => ++calls === 1 ? first.promise : replacement);
    const firstId = ctx.saved(), secondId = ctx.saved();
    const a = ctx.core.regenerateSummary(firstId);
    const b = ctx.core.regenerateSummary(secondId);
    await turn();
    expect(calls).toBe(1);
    expect(ctx.core.jobs.snapshot.map(job => [job.owner, job.status])).toEqual([
      [`meeting:${firstId}`, "running"], [`meeting:${secondId}`, "queued"],
    ]);
    expect(ctx.store.getMeeting(secondId)?.state).toBe("processing");
    first.resolve(replacement);
    await Promise.all([a, b]);
    await ctx.jobs.idle();
    expect(calls).toBe(2);
    expect(ctx.store.getMeeting(firstId)?.summary).toEqual(replacement);
    expect(ctx.store.getMeeting(secondId)?.summary).toEqual(replacement);
    await ctx.core.stop();
  });

  it("continues Detection and Recording events during text generation", async () => {
    const result = deferred<Summary>();
    const ctx = context(() => result.promise);
    const id = ctx.saved();
    const regenerating = ctx.core.regenerateSummary(id);
    await turn();
    ctx.engine.emit({ type: "mic_in_use_started", app: "zoom.us", pid: 42 });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ctx.core.detectedMeeting?.app).toBe("zoom.us");
    expect(ctx.engine.commands).toContainEqual({ type: "start_buffer", app: "zoom.us" });
    ctx.core.acceptPrompt();
    expect(ctx.engine.commands).toContainEqual({ type: "start_recording", app: "zoom.us" });
    ctx.engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-27T10:01:00Z" });
    expect(ctx.core.recording?.app).toBe("zoom.us");
    expect(ctx.store.getMeeting(id)?.state).toBe("processing");
    ctx.engine.emit({ type: "recording_failed", message: "synthetic end" });
    result.resolve(replacement);
    await regenerating;
    await ctx.core.stop();
  });

  it("cancels queued regeneration without discarding the previous Summary", async () => {
    const first = deferred<Summary>();
    const summarise = vi.fn(() => first.promise);
    const ctx = context(summarise);
    const firstId = ctx.saved(), queuedId = ctx.saved();
    const a = ctx.core.regenerateSummary(firstId);
    const b = ctx.core.regenerateSummary(queuedId);
    await turn();
    const queued = ctx.jobs.snapshot.find(job => job.owner === `meeting:${queuedId}`)!;
    ctx.jobs.cancel(queued.id);
    await b;
    expect(ctx.store.getMeeting(queuedId)).toMatchObject({ state: "failed", summary: fixtureSummary });
    expect(summarise).toHaveBeenCalledTimes(1);
    first.resolve(replacement);
    await a;
    await ctx.core.stop();
  });

  it("prevents an actively cancelled generation from saving a late Summary", async () => {
    const nativeResult = deferred<Summary>();
    const ctx = context(() => nativeResult.promise); // Deliberately ignores AbortSignal, like non-cancellable native work.
    const id = ctx.saved();
    const work = ctx.core.regenerateSummary(id);
    await turn();
    ctx.jobs.cancelOwner(`meeting:${id}`);
    await work;
    expect(ctx.store.getMeeting(id)).toMatchObject({ state: "failed", summary: fixtureSummary });
    expect(ctx.jobs.snapshot).toHaveLength(1);
    nativeResult.resolve(replacement);
    await ctx.jobs.idle();
    expect(ctx.store.getMeeting(id)).toMatchObject({ state: "failed", summary: fixtureSummary });
    await ctx.core.stop();
  });

  it("aborts text generation and settles work before shutdown permits storage to close", async () => {
    let signal: AbortSignal | undefined;
    let modelSettled = false;
    const ctx = context((_transcript, options) => new Promise<Summary>((_resolve, reject) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => {
        modelSettled = true;
        reject(new Error("cancelled model request"));
      }, { once: true });
    }));
    const id = ctx.saved();
    const work = ctx.core.regenerateSummary(id);
    await turn();
    expect(signal?.aborted).toBe(false);
    await ctx.core.stop();
    await work;
    expect(signal?.aborted).toBe(true);
    expect(modelSettled).toBe(true);
    expect(ctx.jobs.snapshot).toEqual([]);
    expect(ctx.core.status).toBe("stopped");
    expect(ctx.store.getMeeting(id)).toMatchObject({ state: "failed", summary: fixtureSummary });
    expect(ctx.engine.commands).toContainEqual({ type: "shutdown" });
    // The app closes its store after core.stop(); it remains usable up to this point.
    expect(ctx.store.listMeetings()).toHaveLength(1);
  });

  it("shares the model slot with Settings model preparation until the engine is ready", async () => {
    const summarise = vi.fn(async () => replacement);
    const ctx = context(summarise);
    const setup = new Setup(ctx.engine, ctx.store, {
      speechModel: "tiny.en", modelsDirectory: "/tmp/synthetic-models", jobs: ctx.jobs,
      checkOllama: async () => ({ status: "ready" }),
    });
    setup.downloadModels();
    await turn();
    expect(ctx.engine.commands).toContainEqual({ type: "download_models", model: "tiny.en", modelsDirectory: "/tmp/synthetic-models" });
    const id = ctx.saved();
    const work = ctx.core.regenerateSummary(id);
    await turn();
    expect(summarise).not.toHaveBeenCalled();
    expect(ctx.jobs.snapshot.map(job => job.kind)).toEqual(["speech-model-preparation", "summary"]);
    ctx.engine.emit({ type: "models_ready" });
    await work;
    expect(summarise).toHaveBeenCalledTimes(1);
    expect(setup.state.models.status).toBe("done");
    await ctx.core.stop();
  });
});
