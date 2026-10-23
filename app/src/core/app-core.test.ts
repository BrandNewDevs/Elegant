import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSummariser } from "../pipeline/summariser.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { FakeModel } from "../testing/fake-model.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import { openStore } from "../store/store.js";
import { AppCore } from "./app-core.js";

function setup(pipelineOpts?: Parameters<typeof fakePipeline>[0]) {
  const engine = new FakeEngine();
  const store = openStore(":memory:");
  const core = new AppCore({ engine, store, pipeline: fakePipeline(pipelineOpts) });
  return { engine, store, core };
}

describe("engine status", () => {
  it("is starting until the engine reports ready, then running", () => {
    const { engine, core } = setup();
    core.start();
    expect(engine.started).toBe(true);
    expect(core.status).toBe("starting");

    engine.emit({ type: "ready", version: "0.1.0" });
    expect(core.status).toBe("running");
  });
});

describe("engine lifecycle", () => {
  it("shows crashed when the engine exits on its own", () => {
    const { engine, core } = setup();
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });

    engine.exit({ code: 1, signal: null });
    expect(core.status).toBe("crashed");
  });

  it("shows stopped, and asks the engine to shut down, when the app stops it", async () => {
    const { engine, core } = setup();
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });

    await core.stop();
    expect(engine.commands).toContainEqual({ type: "shutdown" });
    expect(core.status).toBe("stopped");
  });

  it("tells listeners when the status changes", () => {
    const { engine, core } = setup();
    const seen: string[] = [];
    core.onStatusChange((s) => seen.push(s));
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    engine.exit();
    expect(seen).toEqual(["starting", "running", "crashed"]);
  });
});

describe("a recorded meeting", () => {
  const startedAt = "2026-10-24T10:00:00.000Z";
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav" } as const;

  function recording(pipelineOpts?: Parameters<typeof fakePipeline>[0]) {
    const ctx = setup(pipelineOpts);
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    ctx.engine.emit({ type: "recording_started", app: "zoom.us", startedAt });
    return ctx;
  }

  it("shows up as recording while the engine is recording", () => {
    const { core } = recording();
    expect(core.listMeetings()).toMatchObject([{ app: "zoom.us", startedAt, state: "recording" }]);
  });

  it("is stored with its transcript and summary once the tracks are ready", async () => {
    const { engine, core } = recording();
    engine.emit(tracks);
    await core.idle();

    const [listed] = core.listMeetings();
    const meeting = core.getMeeting(listed!.id)!;
    expect(meeting.state).toBe("done");
    expect(meeting.transcript.segments).toEqual(fixtureTranscript.segments);
    expect(meeting.summary).toEqual(fixtureSummary);
    expect(meeting.participants.map((p) => p.label)).toEqual(["You", "Others"]);
  });

  it("is marked processing while the pipeline runs", async () => {
    const { engine, core } = recording();
    engine.emit(tracks);
    expect(core.listMeetings()[0]!.state).toBe("processing");
    await core.idle();
  });

  it("is marked failed, with the reason, when a pipeline stage fails", async () => {
    const { engine, core } = recording({ failSummarise: "ollama is not running" });
    engine.emit(tracks);
    await core.idle();

    const meeting = core.getMeeting(core.listMeetings()[0]!.id)!;
    expect(meeting.state).toBe("failed");
    expect(meeting.error).toBe("ollama is not running");
  });

  it("lists newest meetings first", async () => {
    const { engine, core } = recording();
    engine.emit(tracks);
    await core.idle();
    engine.emit({ type: "recording_started", app: "Slack", startedAt: "2026-10-24T11:00:00.000Z" });
    expect(core.listMeetings().map((m) => m.app)).toEqual(["Slack", "zoom.us"]);
  });

  it("marks the meeting failed when the engine exits in the middle of a recording", () => {
    const { engine, core } = recording();
    engine.exit({ code: 1, signal: null });

    const meeting = core.getMeeting(core.listMeetings()[0]!.id)!;
    expect(meeting.state).toBe("failed");
    expect(meeting.error).toBe("the engine stopped during the recording");
  });

  it("marks an abandoned recording failed when a new one starts", () => {
    const { engine, core } = recording();
    engine.emit({ type: "recording_started", app: "Slack", startedAt: "2026-10-24T11:00:00.000Z" });

    const byApp = Object.fromEntries(core.listMeetings().map((m) => [m.app, m.state]));
    expect(byApp).toEqual({ "zoom.us": "failed", Slack: "recording" });
  });

  it("ignores tracks that arrive when no recording is in progress", async () => {
    const { engine, core } = setup();
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    engine.emit(tracks);
    await core.idle();
    expect(core.listMeetings()).toEqual([]);
  });
});

describe("persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates the database on first start and keeps meetings across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meeting-recorder-test-"));
    dirs.push(dir);
    const dbPath = join(dir, "meetings.db");

    const first = new FakeEngine();
    const store1 = openStore(dbPath);
    const core1 = new AppCore({ engine: first, store: store1, pipeline: fakePipeline() });
    core1.start();
    first.emit({ type: "ready", version: "0.1.0" });
    first.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    first.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav" });
    await core1.idle();
    store1.close();

    const store2 = openStore(dbPath);
    const core2 = new AppCore({ engine: new FakeEngine(), store: store2, pipeline: fakePipeline() });
    const [meeting] = core2.listMeetings();
    expect(meeting).toMatchObject({ app: "zoom.us", state: "done" });
    expect(core2.getMeeting(meeting!.id)!.summary).toEqual(fixtureSummary);
    store2.close();
  });
});

describe("summarising with a language model", () => {
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav" } as const;

  const goodReply = {
    tldr: "Ship the skeleton first.",
    participants: [{ speaker: "You", said: ["Ship the walking skeleton first."] }],
  };

  /** A model that fails until `recover()` is called. */
  function flakyModel() {
    let up = false;
    const model = new FakeModel(() => {
      if (!up) throw new Error("Ollama is not running at http://127.0.0.1:11434");
      return goodReply;
    });
    return { model, recover: () => (up = true) };
  }

  function recordedWith(model: FakeModel) {
    const engine = new FakeEngine();
    const store = openStore(":memory:");
    const pipeline = { transcribe: fakePipeline().transcribe, summarise: createSummariser({ model }) };
    const core = new AppCore({ engine, store, pipeline });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit(tracks);
    return core;
  }

  it("stores the Summary against its Meeting", async () => {
    const core = recordedWith(new FakeModel(() => goodReply));
    await core.idle();
    expect(core.getMeeting(core.listMeetings()[0]!.id)).toMatchObject({ state: "done", summary: goodReply });
  });

  it("marks the Meeting failed, keeping its Transcript, when the model is unavailable", async () => {
    const { model } = flakyModel();
    const core = recordedWith(model);
    await core.idle();

    const meeting = core.getMeeting(core.listMeetings()[0]!.id)!;
    expect(meeting).toMatchObject({ state: "failed", error: "Ollama is not running at http://127.0.0.1:11434", summary: null });
    expect(meeting.transcript.segments).toEqual(fixtureTranscript.segments);
  });

  it("can be retried from the stored Transcript once the model is back", async () => {
    const { model, recover } = flakyModel();
    const core = recordedWith(model);
    await core.idle();
    const id = core.listMeetings()[0]!.id;

    recover();
    await core.retrySummary(id);

    expect(core.getMeeting(id)).toMatchObject({ state: "done", error: null, summary: goodReply });
  });

  it("fails again, still retryable, when the retry meets the same problem", async () => {
    const { model } = flakyModel();
    const core = recordedWith(model);
    await core.idle();
    const id = core.listMeetings()[0]!.id;

    await core.retrySummary(id);
    expect(core.getMeeting(id)!.state).toBe("failed");
  });

  it("refuses to retry a Meeting that did not fail or has no Transcript", async () => {
    const core = recordedWith(new FakeModel(() => goodReply));
    await core.idle();
    await expect(core.retrySummary(core.listMeetings()[0]!.id)).rejects.toThrow(/failed/);
    await expect(core.retrySummary(999)).rejects.toThrow(/no such Meeting/);
  });
});
