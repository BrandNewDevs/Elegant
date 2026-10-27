import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineStages } from "../pipeline/pipeline.js";
import { createSummariser } from "../pipeline/summariser.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { FakeModel } from "../testing/fake-model.js";
import { fakePipeline, fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import { openStore } from "../store/store.js";
import { AppCore, DEFAULT_STOP_TIMEOUT_MS, type ActiveRecording, type DetectedMeeting } from "./app-core.js";
import { DEFAULT_DETECTION } from "./detection.js";
import { ignoredAppsFile } from "./ignored-apps.js";

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
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 } as const;

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
    expect(meeting.participants.map((p) => p.label)).toEqual(["You", "Speaker 1"]);
  });

  it("is done, with no Summary and no failure, when the Recording has no speech", async () => {
    const { engine, core } = recording({ silent: true, failSummarise: "must not be asked to summarise nothing" });
    engine.emit(tracks);
    await core.idle();

    const meeting = core.getMeeting(core.listMeetings()[0]!.id)!;
    expect(meeting).toMatchObject({ state: "done", error: null, summary: null });
    expect(meeting.transcript.segments).toEqual([]);
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

describe("recording and stopping", () => {
  const startedAt = "2026-10-24T10:00:00.000Z";
  const tracks = {
    type: "tracks_ready",
    micPath: "/tmp/mic.wav",
    systemPath: "/tmp/system.wav",
    micStartHostTime: 1000.197,
    systemStartHostTime: 1000,
  } as const;

  const STOP_TIMEOUT = DEFAULT_STOP_TIMEOUT_MS;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function recording() {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    ctx.engine.emit({ type: "mic_in_use_started", app: "zoom.us", pid: 100 });
    vi.advanceTimersByTime(DEFAULT_DETECTION.debounceMs);
    ctx.core.acceptPrompt();
    ctx.engine.emit({ type: "recording_started", app: "zoom.us", startedAt });
    const changes: (ActiveRecording | undefined)[] = [];
    ctx.core.onRecordingChange((r) => changes.push(r));
    const stopsSent = () => ctx.engine.commands.filter((c) => c.type === "stop_recording").length;
    return { ...ctx, changes, stopsSent };
  }

  it("reports the Recording, with when it started, from the moment the engine starts it", () => {
    const { core } = recording();
    expect(core.recording).toEqual({ app: "zoom.us", startedAt });
  });

  it("tells listeners when the Recording starts and ends", () => {
    const ctx = setup();
    ctx.core.start();
    const changes: (ActiveRecording | undefined)[] = [];
    ctx.core.onRecordingChange((r) => changes.push(r));

    ctx.engine.emit({ type: "recording_started", app: "zoom.us", startedAt });
    ctx.core.stopRecording();
    expect(changes).toEqual([{ app: "zoom.us", startedAt }, undefined]);
  });

  it("asks the engine to stop when the user presses Stop, and stops showing the Recording", () => {
    const { core, engine, stopsSent } = recording();
    core.stopRecording();

    expect(engine.commands.at(-1)).toEqual({ type: "stop_recording" });
    expect(stopsSent()).toBe(1);
    expect(core.recording).toBeUndefined();
  });

  it("asks the engine to stop only once, however often Stop is pressed", () => {
    const { core, stopsSent } = recording();
    core.stopRecording();
    core.stopRecording();
    expect(stopsSent()).toBe(1);
  });

  it("ignores Stop when nothing is being recorded", () => {
    const { core, engine } = setup();
    core.stopRecording();
    expect(engine.commands).toEqual([]);
  });

  it("moves the Meeting to processing with the tracks available once the engine hands them over", async () => {
    const { core, engine } = recording();
    core.stopRecording();
    expect(core.listMeetings()[0]!.state).toBe("recording");

    engine.emit(tracks);
    expect(core.listMeetings()[0]!.state).toBe("processing");
    await core.idle();
    expect(core.listMeetings()[0]!.state).toBe("done");
  });

  it("hands the pipeline the aligned tracks", async () => {
    const transcribed: unknown[] = [];
    const engine = new FakeEngine();
    const pipeline = fakePipeline();
    const core = new AppCore({
      engine,
      store: openStore(":memory:"),
      pipeline: { ...pipeline, transcribe: (t) => (transcribed.push(t), pipeline.transcribe(t)) },
    });
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt });
    core.stopRecording();
    engine.emit(tracks);
    await core.idle();

    expect(transcribed).toEqual([{ micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav" }]);
  });

  it("is not ended by the call app releasing the microphone", () => {
    const { core, engine, stopsSent } = recording();
    engine.emit({ type: "mic_in_use_stopped", app: "zoom.us", pid: 100 });
    vi.advanceTimersByTime(60 * 60_000);

    expect(stopsSent()).toBe(0);
    expect(core.recording).toBeDefined();
    expect(core.listMeetings()[0]!.state).toBe("recording");
  });

  it("is not ended by time passing, the Prompt timing out, or another app using the microphone", () => {
    const { core, engine, stopsSent } = recording();
    engine.emit({ type: "mic_in_use_started", app: "Slack", pid: 200 });
    vi.advanceTimersByTime(DEFAULT_DETECTION.promptTimeoutMs + DEFAULT_DETECTION.debounceMs);
    core.declinePrompt();
    core.acceptPrompt();
    vi.advanceTimersByTime(8 * 60 * 60_000);

    expect(engine.commands.map((c) => c.type)).not.toContain("stop_recording");
    expect(stopsSent()).toBe(0);
    expect(core.recording).toBeDefined();
    expect(core.listMeetings()[0]!.state).toBe("recording");
  });

  it("marks the Meeting failed, with the reason, when the engine reports the Recording cannot finish", () => {
    const { core, engine } = recording();
    core.stopRecording();
    engine.emit({ type: "recording_failed", message: "the system audio track stopped" });

    expect(core.getMeeting(core.listMeetings()[0]!.id)).toMatchObject({
      state: "failed",
      error: "the system audio track stopped",
    });
  });

  it("tells listeners, and stores nothing, when the engine cannot start the Recording", () => {
    const ctx = setup();
    ctx.core.start();
    const problems: string[] = [];
    ctx.core.onRecordingFailed((message) => problems.push(message));

    ctx.engine.emit({ type: "recording_failed", message: "cannot start recording: microphone access is denied" });

    expect(problems).toEqual(["cannot start recording: microphone access is denied"]);
    expect(ctx.core.recording).toBeUndefined();
    expect(ctx.core.listMeetings()).toEqual([]);
  });

  it("tells listeners about engine trouble without ending the Recording", () => {
    const { core, engine } = recording();
    const problems: string[] = [];
    core.onEngineProblem((message) => problems.push(message));
    engine.emit({ type: "error", message: "the microphone could not be restarted" });
    expect(problems).toEqual(["the microphone could not be restarted"]);
    expect(core.recording).toBeDefined();
  });

  it("tells listeners when a Recording that was running cannot finish", () => {
    const { core, engine } = recording();
    const problems: string[] = [];
    core.onRecordingFailed((message) => problems.push(message));
    engine.emit({ type: "recording_failed", message: "no audio was captured on the system audio track" });
    expect(problems).toEqual(["no audio was captured on the system audio track"]);
  });

  it("marks the Meeting failed when the engine never hands over the tracks after Stop", () => {
    const { core } = recording();
    core.stopRecording();
    vi.advanceTimersByTime(STOP_TIMEOUT - 1);
    expect(core.listMeetings()[0]!.state).toBe("recording");

    vi.advanceTimersByTime(1);
    expect(core.getMeeting(core.listMeetings()[0]!.id)).toMatchObject({
      state: "failed",
      error: "the engine did not hand over the tracks after Stop",
    });
  });

  it("does not time out once the tracks have arrived", async () => {
    const { core, engine } = recording();
    core.stopRecording();
    engine.emit(tracks);
    await core.idle();
    vi.advanceTimersByTime(STOP_TIMEOUT * 2);
    expect(core.listMeetings()[0]!.state).toBe("done");
  });

  describe("quitting the app", () => {
    it("stops a Recording in progress before shutting the engine down, so the audio is kept", async () => {
      const { core, engine } = recording();
      const quit = core.stop();
      expect(engine.commands.map((c) => c.type).slice(-1)).toEqual(["stop_recording"]);
      expect(engine.commands).not.toContainEqual({ type: "shutdown" });

      engine.emit(tracks);
      await quit;

      expect(engine.commands.map((c) => c.type).slice(-2)).toEqual(["stop_recording", "shutdown"]);
      expect(core.getMeeting(core.listMeetings()[0]!.id)).toMatchObject({
        state: "failed",
        error: "the app quit before this Recording was processed; the audio is in /tmp",
      });
    });

    it("does not wait forever for an engine that never answers", async () => {
      const { core, engine } = recording();
      const quit = core.stop();
      vi.advanceTimersByTime(STOP_TIMEOUT);
      await quit;

      expect(engine.commands).toContainEqual({ type: "shutdown" });
      expect(core.listMeetings()[0]!.state).toBe("failed");
    });

    it("waits for a Recording already stopped but not yet handed over", async () => {
      const { core, engine } = recording();
      core.stopRecording();
      const quit = core.stop();
      engine.emit(tracks);
      await quit;
      expect(core.listMeetings()[0]!.state).toBe("failed");
    });

    it("shuts down at once when nothing is being recorded", async () => {
      const { core, engine } = setup();
      await core.stop();
      expect(engine.commands).toEqual([{ type: "shutdown" }]);
    });
  });

  it("stops showing a Recording the engine reports failed, and the engine exiting ends it too", () => {
    const first = recording();
    first.engine.emit({ type: "recording_failed", message: "no microphone" });
    expect(first.core.recording).toBeUndefined();

    const second = recording();
    second.engine.exit();
    expect(second.core.recording).toBeUndefined();
  });
});

describe("the audio of a Recording", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Records a Meeting whose two tracks are real files in a directory of their own, as the engine leaves them. */
  async function recordedWithAudio(opts: { pipeline?: Parameters<typeof fakePipeline>[0]; keepAudio?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "elegant-audio-"));
    dirs.push(dir);
    const micPath = join(dir, "mic.wav");
    const systemPath = join(dir, "system.wav");
    writeFileSync(micPath, "mic");
    writeFileSync(systemPath, "system");

    const engine = new FakeEngine();
    const core = new AppCore({
      engine,
      store: openStore(":memory:"),
      pipeline: fakePipeline(opts.pipeline),
    });
    core.setKeepAudio(opts.keepAudio ?? false);
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    core.stopRecording();
    engine.emit({ type: "tracks_ready", micPath, systemPath, micStartHostTime: 1000.197, systemStartHostTime: 1000 });
    await core.idle();
    return { dir, core };
  }

  it("is deleted once it has been transcribed", async () => {
    const { dir } = await recordedWithAudio();
    expect(existsSync(dir)).toBe(false);
  });

  it("is deleted once it has been transcribed, even if the Summary then fails", async () => {
    const { dir, core } = await recordedWithAudio({ pipeline: { failSummarise: "ollama is not running" } });
    expect(core.listMeetings()[0]!.state).toBe("failed");
    expect(existsSync(dir)).toBe(false);
  });

  it("is kept when transcription fails, so it can be transcribed again", async () => {
    const { dir } = await recordedWithAudio({ pipeline: { failTranscribe: "model missing" } });
    expect(existsSync(join(dir, "mic.wav"))).toBe(true);
    expect(existsSync(join(dir, "system.wav"))).toBe(true);
  });

  it("is kept when the keep-audio setting is on", async () => {
    const { dir } = await recordedWithAudio({ keepAudio: true });
    expect(existsSync(join(dir, "mic.wav"))).toBe(true);
  });

  it("leaves other files in its directory alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elegant-audio-"));
    dirs.push(dir);
    writeFileSync(join(dir, "mic.wav"), "mic");
    writeFileSync(join(dir, "system.wav"), "system");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    const engine = new FakeEngine();
    const core = new AppCore({ engine, store: openStore(":memory:"), pipeline: fakePipeline() });
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit({
      type: "tracks_ready",
      micPath: join(dir, "mic.wav"),
      systemPath: join(dir, "system.wav"),
      micStartHostTime: 1,
      systemStartHostTime: 1,
    });
    await core.idle();

    expect(existsSync(join(dir, "mic.wav"))).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });
});

describe("detecting a meeting", () => {
  const DEBOUNCE = DEFAULT_DETECTION.debounceMs;
  const TIMEOUT = DEFAULT_DETECTION.promptTimeoutMs;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function running() {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    const prompts: (DetectedMeeting | undefined)[] = [];
    ctx.core.onDetectedMeetingChange((m) => prompts.push(m));
    const micStarted = (app: string, pid = 100) => ctx.engine.emit({ type: "mic_in_use_started", app, pid });
    const micStopped = (app: string, pid = 100) => ctx.engine.emit({ type: "mic_in_use_stopped", app, pid });
    return { ...ctx, prompts, micStarted, micStopped };
  }

  function prompted(app = "zoom.us") {
    const ctx = running();
    ctx.micStarted(app);
    vi.advanceTimersByTime(DEBOUNCE);
    return ctx;
  }

  it("creates a detected meeting, and shows the Prompt, once a listed app has held the microphone for the debounce", () => {
    const { core, prompts, micStarted } = running();
    micStarted("zoom.us");

    vi.advanceTimersByTime(DEBOUNCE - 1);
    expect(core.detectedMeeting).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(core.detectedMeeting).toMatchObject({ app: "zoom.us", state: "detected" });
    expect(prompts).toEqual([core.detectedMeeting]);
  });

  it("matches listed apps regardless of case", () => {
    const { core, micStarted } = running();
    micStarted("Google Chrome");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(core.detectedMeeting?.app).toBe("Google Chrome");
  });

  it("shows no Prompt for a built-in ignored app", () => {
    const { core, prompts, micStarted } = running();
    micStarted("Siri");
    vi.advanceTimersByTime(60_000);
    expect(core.detectedMeeting).toBeUndefined();
    expect(prompts).toEqual([]);
  });

  it("shows no Prompt when the microphone is released before the debounce is over", () => {
    const { core, micStarted, micStopped } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE - 1);
    micStopped("zoom.us");
    vi.advanceTimersByTime(60_000);
    expect(core.detectedMeeting).toBeUndefined();
  });

  it("detects an app once, however many of its helper processes use the microphone", () => {
    const { prompts, micStarted } = running();
    micStarted("Google Chrome", 1);
    micStarted("Google Chrome", 2);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(prompts).toHaveLength(1);
  });

  it("keeps the app detected while any helper process still holds the microphone", () => {
    const { core, prompts, micStarted, micStopped } = prompted("Google Chrome");
    micStarted("Google Chrome", 2);
    micStopped("Google Chrome", 100);
    expect(core.detectedMeeting).toBeDefined();
    expect(prompts).toHaveLength(1);
  });

  it("starts the Recording when the user accepts, and stores the meeting only then", () => {
    const { core, engine } = prompted();
    expect(core.listMeetings()).toEqual([]);

    core.acceptPrompt();
    expect(engine.commands).toContainEqual({ type: "start_recording", app: "zoom.us" });
    expect(core.detectedMeeting).toBeUndefined();

    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    expect(core.listMeetings()).toMatchObject([{ app: "zoom.us", state: "recording" }]);
  });

  it("discards the buffered audio and stores nothing when the user says not now", () => {
    const { core, engine, prompts } = prompted();
    core.declinePrompt();

    expect(engine.commands).toContainEqual({ type: "discard_buffer" });
    expect(engine.commands).not.toContainEqual({ type: "start_recording", app: "zoom.us" });
    expect(core.detectedMeeting).toBeUndefined();
    expect(prompts.at(-1)).toBeUndefined();
    expect(core.listMeetings()).toEqual([]);
  });

  it("treats an ignored Prompt as a decline once it times out", () => {
    const { core, engine } = prompted();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(core.detectedMeeting).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(core.detectedMeeting).toBeUndefined();
    expect(engine.commands).toContainEqual({ type: "discard_buffer" });
    expect(engine.commands).not.toContainEqual({ type: "start_recording", app: "zoom.us" });
    expect(core.listMeetings()).toEqual([]);
  });

  it("does not time out once the user has answered", () => {
    const { engine, core } = prompted();
    core.acceptPrompt();
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(engine.commands.filter((c) => c.type === "discard_buffer")).toEqual([]);
  });

  it("withdraws the Prompt, leaving nothing stored, when the app releases the microphone unanswered", () => {
    const { core, engine, micStopped } = prompted();
    micStopped("zoom.us");
    expect(core.detectedMeeting).toBeUndefined();
    expect(engine.commands).toContainEqual({ type: "discard_buffer" });
    expect(core.listMeetings()).toEqual([]);
  });

  it("does not ask again about the same call after a decline", () => {
    const { core, prompts, micStarted } = prompted("Google Chrome");
    core.declinePrompt();
    micStarted("Google Chrome", 2);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(prompts.filter(Boolean)).toHaveLength(1);
  });

  it("asks again when the app takes the microphone for a later call", () => {
    const { core, prompts, micStarted, micStopped } = prompted();
    core.declinePrompt();
    micStopped("zoom.us");
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE);
    expect(prompts.filter(Boolean)).toHaveLength(2);
    expect(core.detectedMeeting).toBeDefined();
  });

  it("does not prompt for a second app while a Prompt is showing or a Recording is in progress", () => {
    const { core, engine, prompts, micStarted } = prompted();
    micStarted("Slack", 200);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(core.detectedMeeting?.app).toBe("zoom.us");

    core.acceptPrompt();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    micStarted("FaceTime", 300);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(prompts.filter(Boolean)).toHaveLength(1);
  });

  it("drops a pending Prompt when the engine exits", () => {
    const { core, engine } = prompted();
    engine.exit();
    expect(core.detectedMeeting).toBeUndefined();
    vi.advanceTimersByTime(TIMEOUT);
    expect(core.listMeetings()).toEqual([]);
  });

  it("ignores accept and decline when there is no Prompt", () => {
    const { core, engine } = running();
    core.acceptPrompt();
    core.declinePrompt();
    expect(engine.commands).toEqual([]);
  });
});

describe("holding audio from Detection", () => {
  const DEBOUNCE = DEFAULT_DETECTION.debounceMs;
  const TIMEOUT = DEFAULT_DETECTION.promptTimeoutMs;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function running() {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    const micStarted = (app: string, pid = 100) => ctx.engine.emit({ type: "mic_in_use_started", app, pid });
    return { ...ctx, micStarted };
  }

  it("asks the engine to hold audio from the moment of Detection, not before", () => {
    const { engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE - 1);
    expect(engine.commands).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(engine.commands).toEqual([{ type: "start_buffer", app: "zoom.us" }]);
  });

  it("asks for nothing when a built-in ignored app uses the microphone", () => {
    const { engine, micStarted } = running();
    micStarted("Dictation");
    vi.advanceTimersByTime(60_000);
    expect(engine.commands).toEqual([]);
  });

  it("keeps the buffer when the user accepts late: the engine is told to record, not to discard", () => {
    const { core, engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE + TIMEOUT - 1);
    core.acceptPrompt();
    expect(engine.commands).toEqual([
      { type: "start_buffer", app: "zoom.us" },
      { type: "start_recording", app: "zoom.us" },
    ]);
  });

  it("discards the buffer when the user declines", () => {
    const { core, engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE);
    core.declinePrompt();
    expect(engine.commands).toEqual([{ type: "start_buffer", app: "zoom.us" }, { type: "discard_buffer" }]);
    expect(core.listMeetings()).toEqual([]);
  });

  it("discards the buffer when the Prompt is ignored", () => {
    const { core, engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE + TIMEOUT);
    expect(engine.commands).toEqual([{ type: "start_buffer", app: "zoom.us" }, { type: "discard_buffer" }]);
    expect(core.listMeetings()).toEqual([]);
  });

  it("discards the buffer when the call ends before the user answers", () => {
    const { engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE);
    engine.emit({ type: "mic_in_use_stopped", app: "zoom.us", pid: 100 });
    expect(engine.commands).toEqual([{ type: "start_buffer", app: "zoom.us" }, { type: "discard_buffer" }]);
  });

  it("holds audio for one Meeting at a time", () => {
    const { engine, micStarted } = running();
    micStarted("zoom.us");
    vi.advanceTimersByTime(DEBOUNCE);
    micStarted("Slack", 200);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(engine.commands).toEqual([{ type: "start_buffer", app: "zoom.us" }]);
  });
});

describe("nudging the user to stop", () => {
  const DEBOUNCE = DEFAULT_DETECTION.debounceMs;
  const startedAt = "2026-10-24T10:00:00.000Z";

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function inACall(app = "zoom.us") {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    ctx.engine.emit({ type: "mic_in_use_started", app, pid: 100 });
    vi.advanceTimersByTime(DEBOUNCE);
    const nudges: string[] = [];
    ctx.core.onStopNudge((a) => nudges.push(a));
    const micStopped = (a = app, pid = 100) => ctx.engine.emit({ type: "mic_in_use_stopped", app: a, pid });
    const record = () => {
      ctx.core.acceptPrompt();
      ctx.engine.emit({ type: "recording_started", app, startedAt });
    };
    return { ...ctx, nudges, micStopped, record };
  }

  it("nudges when the call app releases the microphone during a Recording", () => {
    const { nudges, micStopped, record } = inACall();
    record();
    micStopped();
    expect(nudges).toEqual(["zoom.us"]);
  });

  it("leaves the Recording running, however long the nudge is ignored", () => {
    const { core, engine, nudges, micStopped, record } = inACall();
    record();
    micStopped();
    vi.advanceTimersByTime(8 * 60 * 60 * 1000);
    expect(nudges).toHaveLength(1);
    expect(core.recording).toEqual({ app: "zoom.us", startedAt });
    expect(core.listMeetings()).toMatchObject([{ state: "recording" }]);
    expect(engine.commands.filter((c) => c.type === "stop_recording")).toEqual([]);
  });

  it("waits for the last helper process of the call app to let go", () => {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "mic_in_use_started", app: "Google Chrome", pid: 1 });
    ctx.engine.emit({ type: "mic_in_use_started", app: "Google Chrome", pid: 2 });
    vi.advanceTimersByTime(DEBOUNCE);
    const nudges: string[] = [];
    ctx.core.onStopNudge((a) => nudges.push(a));
    ctx.core.acceptPrompt();
    ctx.engine.emit({ type: "recording_started", app: "Google Chrome", startedAt });

    ctx.engine.emit({ type: "mic_in_use_stopped", app: "Google Chrome", pid: 1 });
    expect(nudges).toEqual([]);
    ctx.engine.emit({ type: "mic_in_use_stopped", app: "Google Chrome", pid: 2 });
    expect(nudges).toEqual(["Google Chrome"]);
  });

  it("does not nudge when no Recording is in progress", () => {
    const { nudges, micStopped } = inACall();
    micStopped(); // the Prompt is still open: it is withdrawn, not nudged
    expect(nudges).toEqual([]);
  });

  it("does not nudge once the Recording has been stopped", () => {
    const { core, nudges, micStopped, record } = inACall();
    record();
    core.stopRecording();
    micStopped();
    expect(nudges).toEqual([]);
  });

  it("does not nudge for an app that is not the one being recorded", () => {
    const { engine, nudges, record } = inACall();
    record();
    engine.emit({ type: "mic_in_use_started", app: "Slack", pid: 200 });
    engine.emit({ type: "mic_in_use_stopped", app: "Slack", pid: 200 });
    expect(nudges).toEqual([]);
  });
});

describe("the keep-audio setting and deleting a Meeting", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** Makes the two tracks the engine would leave, in a directory of their own. */
  function tracksOnDisk() {
    const dir = mkdtempSync(join(tmpdir(), "elegant-audio-"));
    dirs.push(dir);
    const micPath = join(dir, "mic.wav");
    const systemPath = join(dir, "system.wav");
    writeFileSync(micPath, "mic");
    writeFileSync(systemPath, "system");
    return { dir, micPath, systemPath };
  }

  async function record(core: AppCore, engine: FakeEngine, pipelineDone = true) {
    const files = tracksOnDisk();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    core.stopRecording();
    engine.emit({ type: "tracks_ready", micPath: files.micPath, systemPath: files.systemPath, micStartHostTime: 1, systemStartHostTime: 1 });
    if (pipelineDone) await core.idle();
    return files;
  }

  it("is off until the user turns it on", () => {
    const { core } = setup();
    expect(core.keepAudio).toBe(false);
    core.setKeepAudio(true);
    expect(core.keepAudio).toBe(true);
    core.setKeepAudio(false);
    expect(core.keepAudio).toBe(false);
  });

  it("is remembered by the store, so it survives a restart", () => {
    const store = openStore(":memory:");
    new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() }).setKeepAudio(true);
    expect(new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() }).keepAudio).toBe(true);
  });

  it("applies to the next Recording without restarting", async () => {
    const { core, engine } = setup();
    core.start();
    const first = await record(core, engine);
    expect(existsSync(first.dir)).toBe(false);

    core.setKeepAudio(true);
    const second = await record(core, engine);
    expect(existsSync(second.micPath)).toBe(true);

    core.setKeepAudio(false);
    const third = await record(core, engine);
    expect(existsSync(third.dir)).toBe(false);
  });

  it("deleting a Meeting removes its Transcript, Summary, Participants and kept audio", async () => {
    const { core, engine, store } = setup();
    core.start();
    core.setKeepAudio(true);
    const files = await record(core, engine);
    const id = core.listMeetings()[0]!.id;
    expect(store.getMeeting(id)).toMatchObject({ state: "done", audio: { micPath: files.micPath } });

    await core.deleteMeeting(id);

    expect(core.listMeetings()).toEqual([]);
    expect(core.getMeeting(id)).toBeUndefined();
    expect(existsSync(files.dir)).toBe(false);
  });

  it("deleting a failed Meeting removes the audio kept for its retry", async () => {
    const { core, engine } = setup({ failTranscribe: "model missing" });
    core.start();
    const files = await record(core, engine);
    const id = core.listMeetings()[0]!.id;
    expect(existsSync(files.micPath)).toBe(true);

    await core.deleteMeeting(id);
    expect(existsSync(files.dir)).toBe(false);
    expect(core.listMeetings()).toEqual([]);
  });

  it("tells the Meetings window that a Meeting was deleted", async () => {
    const { core, engine } = setup();
    core.start();
    await record(core, engine);
    const id = core.listMeetings()[0]!.id;
    let changes = 0;
    core.onMeetingsChanged(() => changes++);
    await core.deleteMeeting(id);
    expect(changes).toBe(1);
  });

  it("refuses to delete a Meeting that is still recording or being processed", async () => {
    const { core, engine } = setup();
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    const id = core.listMeetings()[0]!.id;
    await expect(core.deleteMeeting(id)).rejects.toThrow(/recording/);
    expect(core.getMeeting(id)).toBeDefined();
  });

  it("refuses to delete a Meeting that does not exist", async () => {
    const { core } = setup();
    await expect(core.deleteMeeting(99)).rejects.toThrow(/no such Meeting/);
  });
});

describe("what the Meetings window sees", () => {
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 } as const;

  function started() {
    const ctx = setup();
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    return ctx;
  }

  it("is told when a Meeting appears and each time its state changes", async () => {
    const { engine, core } = started();
    const seen: string[] = [];
    core.onMeetingsChanged(() => seen.push(core.listMeetings()[0]?.state ?? "none"));

    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit(tracks);
    await core.idle();

    expect(seen).toEqual(["recording", "processing", "done"]);
  });

  it("keeps recording state changes even if a listener throws", async () => {
    const { engine, core } = started();
    vi.spyOn(console, "error").mockImplementation(() => {});
    core.onMeetingsChanged(() => {
      throw new Error("window is gone");
    });

    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit(tracks);
    await core.idle();

    expect(core.listMeetings()[0]!.state).toBe("done");
  });

  it("is told when a Meeting fails, with the reason available", async () => {
    const ctx = setup({ failTranscribe: "model missing" });
    ctx.core.start();
    ctx.engine.emit({ type: "ready", version: "0.1.0" });
    let changes = 0;
    ctx.core.onMeetingsChanged(() => changes++);

    ctx.engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    ctx.engine.emit(tracks);
    await ctx.core.idle();

    expect(changes).toBe(3);
    expect(ctx.core.getMeeting(ctx.core.listMeetings()[0]!.id)).toMatchObject({
      state: "failed",
      error: "model missing",
    });
  });

  it("does not store a Meeting when the microphone was used but no Recording was started", () => {
    const { engine, core } = started();
    let changes = 0;
    core.onMeetingsChanged(() => changes++);

    engine.emit({ type: "mic_in_use_started", app: "zoom.us", pid: 4242 });
    engine.emit({ type: "mic_in_use_stopped", app: "zoom.us", pid: 4242 });

    expect(core.listMeetings()).toEqual([]);
    expect(changes).toBe(0);
  });

  it("shows stored Meetings of every state, newest first, including ones from before this run", () => {
    const store = openStore(":memory:");
    const older = store.createMeeting({ app: "Slack", startedAt: "2026-10-23T09:00:00.000Z" });
    store.saveTranscript(older, fixtureTranscript);
    store.saveSummary(older, fixtureSummary);
    store.setMeetingState(older, "done");
    const middle = store.createMeeting({ app: "Teams", startedAt: "2026-10-24T09:00:00.000Z" });
    store.setMeetingState(middle, "failed", "ollama is not running");
    const newest = store.createMeeting({ app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    store.setMeetingState(newest, "processing");
    const core = new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() });

    expect(core.listMeetings().map((m) => [m.app, m.state])).toEqual([
      ["zoom.us", "processing"],
      ["Teams", "failed"],
      ["Slack", "done"],
    ]);
    expect(core.getMeeting(older)).toMatchObject({
      transcript: fixtureTranscript,
      summary: fixtureSummary,
    });
  });
});

describe("persistence", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("creates the database on first start and keeps meetings across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elegant-test-"));
    dirs.push(dir);
    const dbPath = join(dir, "meetings.db");

    const first = new FakeEngine();
    const store1 = openStore(dbPath);
    const core1 = new AppCore({ engine: first, store: store1, pipeline: fakePipeline() });
    core1.start();
    first.emit({ type: "ready", version: "0.1.0" });
    first.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    first.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 });
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
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 } as const;

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

describe("regenerating a Summary", () => {
  const tracks = { type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1000.197, systemStartHostTime: 1000 } as const;
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const reply = (tldr: string) => ({ tldr, participants: [{ speaker: "You", said: ["Ship the walking skeleton first."] }] });

  /** A finished Meeting whose model is answered by `answer`, which the test can change between runs. */
  async function summarised(answer: { current: () => unknown }, dbPath = ":memory:") {
    const engine = new FakeEngine();
    const store = openStore(dbPath);
    const model = new FakeModel(() => answer.current());
    const core = new AppCore({ engine, store, pipeline: { transcribe: fakePipeline().transcribe, summarise: createSummariser({ model }) } });
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit(tracks);
    await core.idle();
    return { core, store, id: core.listMeetings()[0]!.id };
  }

  it("replaces the Summary with one from the current model", async () => {
    const answer = { current: () => reply("First attempt.") };
    const { core, id } = await summarised(answer);
    expect(core.getMeeting(id)!.summary!.tldr).toBe("First attempt.");

    answer.current = () => reply("Second attempt.");
    await core.regenerateSummary(id);

    expect(core.getMeeting(id)).toMatchObject({ state: "done", error: null, summary: reply("Second attempt.") });
    expect(core.getMeeting(id)!.transcript.segments).toEqual(fixtureTranscript.segments);
  });

  it("works after a Participant was renamed, and keeps the name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elegant-test-"));
    dirs.push(dir);
    const dbPath = join(dir, "meetings.db");
    const answer = { current: () => reply("First attempt.") };
    const { core, store, id } = await summarised(answer, dbPath);

    core.renameParticipant(id, "Speaker 1", "Alice");

    answer.current = () => reply("After the rename.");
    await core.regenerateSummary(id);

    const meeting = core.getMeeting(id)!;
    expect(meeting).toMatchObject({ state: "done", summary: reply("After the rename.") });
    expect(meeting.participants).toContainEqual({ label: "Speaker 1", name: "Alice" });
    store.close();
  });

  it("keeps the old Summary, and can be retried, when the model fails", async () => {
    const answer = { current: (): unknown => reply("First attempt.") };
    const { core, id } = await summarised(answer);

    answer.current = () => {
      throw new Error("Ollama is not running at http://127.0.0.1:11434");
    };
    await core.regenerateSummary(id);
    expect(core.getMeeting(id)).toMatchObject({ state: "failed", summary: reply("First attempt.") });

    answer.current = () => reply("Third attempt.");
    await core.regenerateSummary(id);
    expect(core.getMeeting(id)).toMatchObject({ state: "done", error: null, summary: reply("Third attempt.") });
  });

  it("tells the Meetings window that the Meeting is processing, then done", async () => {
    const { core, id } = await summarised({ current: () => reply("First attempt.") });
    const states: string[] = [];
    core.onMeetingsChanged(() => states.push(core.getMeeting(id)!.state));
    await core.regenerateSummary(id);
    expect(states).toEqual(["processing", "done"]);
  });

  it("refuses a Meeting that does not exist, is still being processed, or has no Transcript", async () => {
    const { core, engine } = setup({ silent: true });
    core.start();
    await expect(core.regenerateSummary(99)).rejects.toThrow(/no such Meeting/);

    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    const id = core.listMeetings()[0]!.id;
    await expect(core.regenerateSummary(id)).rejects.toThrow(/recording/);

    engine.emit(tracks);
    await core.idle();
    await expect(core.regenerateSummary(id)).rejects.toThrow(/no Transcript/);
  });
});

describe("retrying a failed transcription", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "retry-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function recordedAndFailed() {
    const micPath = join(dir, "mic.wav"), systemPath = join(dir, "system.wav");
    writeFileSync(micPath, "");
    writeFileSync(systemPath, "");
    let failing = true;
    const healthy = fakePipeline();
    const pipeline: PipelineStages = {
      transcribe: async (t) => {
        if (failing) throw new Error("the speech model is not downloaded");
        return healthy.transcribe(t);
      },
      summarise: healthy.summarise,
    };
    const engine = new FakeEngine();
    const core = new AppCore({ engine, store: openStore(":memory:"), pipeline });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    engine.emit({ type: "tracks_ready", micPath, systemPath, micStartHostTime: 1000.197, systemStartHostTime: 1000 });
    return { core, micPath, systemPath, recover: () => (failing = false) };
  }

  it("keeps the audio when transcription fails", async () => {
    const { core, micPath, systemPath } = recordedAndFailed();
    await core.idle();
    const meeting = core.getMeeting(core.listMeetings()[0]!.id)!;
    expect(meeting).toMatchObject({ state: "failed", error: "the speech model is not downloaded", audio: { micPath, systemPath } });
    expect(existsSync(micPath) && existsSync(systemPath)).toBe(true);
  });

  it("transcribes again from the kept audio, then deletes it", async () => {
    const { core, micPath, systemPath, recover } = recordedAndFailed();
    await core.idle();
    const id = core.listMeetings()[0]!.id;

    recover();
    await core.retryTranscription(id);

    const meeting = core.getMeeting(id)!;
    expect(meeting).toMatchObject({ state: "done", error: null, audio: null, summary: fixtureSummary });
    expect(meeting.transcript.segments).toEqual(fixtureTranscript.segments);
    expect(existsSync(micPath) || existsSync(systemPath)).toBe(false);
  });

  it("stays failed, with the audio kept, when the retry fails too", async () => {
    const { core, micPath } = recordedAndFailed();
    await core.idle();
    const id = core.listMeetings()[0]!.id;

    await core.retryTranscription(id);
    expect(core.getMeeting(id)).toMatchObject({ state: "failed", audio: { micPath } });
  });

  it("refuses when the Meeting does not exist, did not fail, or its audio is gone", async () => {
    const { core, micPath, recover } = recordedAndFailed();
    await core.idle();
    const id = core.listMeetings()[0]!.id;
    await expect(core.retryTranscription(999)).rejects.toThrow(/no such Meeting/);

    rmSync(micPath);
    await expect(core.retryTranscription(id)).rejects.toThrow(/no longer there/);

    writeFileSync(micPath, "");
    recover();
    await core.retryTranscription(id);
    await expect(core.retryTranscription(id)).rejects.toThrow(/failed/);
  });
});

describe("exporting a Meeting to Markdown", () => {
  function seeded() {
    const dir = mkdtempSync(join(tmpdir(), "export-"));
    const path = join(dir, "meetings.db");
    const store = openStore(path);
    const id = store.createMeeting({ app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    store.saveTranscript(id, fixtureTranscript);
    store.saveSummary(id, fixtureSummary);
    store.setMeetingState(id, "done");
    const core = new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() });
    return { id, core, path, dir };
  }

  it("has the Summary and the Transcript", () => {
    const { id, core, dir } = seeded();
    const { markdown, fileName } = core.exportMeeting(id);
    rmSync(dir, { recursive: true });

    expect(fileName).toBe("zoom.us 2026-10-24 10-00.md");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain(fixtureSummary.tldr);
    expect(markdown).toContain("- Fan out to detection and the window afterwards.");
    expect(markdown).toContain("## Transcript");
    expect(markdown).toContain("**You** (0:00): Let's ship the walking skeleton first.");
    expect(markdown).toContain("**Speaker 1** (0:03): Agreed, then fan out to detection and the window.");
  });

  it("shows a renamed Participant by name in the Summary and the Transcript, and leaves the others as labelled", async () => {
    const { id, core, dir } = seeded();
    core.renameParticipant(id, "Speaker 1", "Priya");

    const { markdown } = core.exportMeeting(id);
    rmSync(dir, { recursive: true });

    expect(markdown).toContain("### Priya");
    expect(markdown).toContain("**Priya** (0:03): Agreed");
    expect(markdown).not.toContain("Speaker 1");
    expect(markdown).toContain("### You");
  });

  it("exports a Meeting that has no Summary yet, with just its Transcript", () => {
    const store = openStore(":memory:");
    const id = store.createMeeting({ app: "Slack", startedAt: "2026-10-24T10:00:00.000Z" });
    store.saveTranscript(id, fixtureTranscript);
    store.setMeetingState(id, "failed", "ollama is not running");
    const core = new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() });

    const { markdown } = core.exportMeeting(id);
    expect(markdown).not.toContain("## Summary");
    expect(markdown).toContain("## Transcript");
  });

  it("refuses a Meeting that does not exist", () => {
    const { core } = setup();
    expect(() => core.exportMeeting(99)).toThrow(/no such Meeting/);
  });
});

describe("Never for this app", () => {
  const DEBOUNCE = DEFAULT_DETECTION.debounceMs;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function running(store = openStore(":memory:")) {
    const engine = new FakeEngine();
    const core = new AppCore({ engine, store, pipeline: fakePipeline() });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    const detect = (app: string, pid = 100) => {
      engine.emit({ type: "mic_in_use_started", app, pid });
      vi.advanceTimersByTime(DEBOUNCE);
    };
    const release = (app: string, pid = 100) => engine.emit({ type: "mic_in_use_stopped", app, pid });
    return { engine, store, core, detect, release };
  }

  it("closes the Prompt, discards the buffered audio and keeps nothing about the Meeting", () => {
    const { core, engine, detect } = running();
    detect("zoom.us");
    core.neverForThisApp();

    expect(core.detectedMeeting).toBeUndefined();
    expect(engine.commands).toContainEqual({ type: "discard_buffer" });
    expect(engine.commands).not.toContainEqual(expect.objectContaining({ type: "start_recording" }));
    expect(core.listMeetings()).toEqual([]);
    expect(core.neverApps).toEqual(["zoom.us"]);
  });

  it("shows no Prompt, and buffers no audio, when that app is detected again", () => {
    const { core, engine, detect, release } = running();
    detect("zoom.us");
    core.neverForThisApp();
    release("zoom.us");
    engine.commands.length = 0;

    detect("ZOOM.US");
    expect(core.detectedMeeting).toBeUndefined();
    expect(engine.commands).toEqual([]);
  });

  it("still prompts for other apps", () => {
    const { core, detect } = running();
    detect("zoom.us");
    core.neverForThisApp();
    detect("Slack", 200);
    expect(core.detectedMeeting?.app).toBe("Slack");
  });

  it("is remembered after a restart", () => {
    const first = running();
    first.detect("zoom.us");
    first.core.neverForThisApp();

    const second = running(first.store);
    second.detect("zoom.us");
    expect(second.core.detectedMeeting).toBeUndefined();
  });

  it("can be undone, after which the app is prompted for again", () => {
    const { core, detect, release } = running();
    detect("zoom.us");
    core.neverForThisApp();
    release("zoom.us");

    core.allowApp("zoom.us");
    expect(core.neverApps).toEqual([]);
    detect("zoom.us");
    expect(core.detectedMeeting?.app).toBe("zoom.us");
  });

  it("does nothing when there is no Prompt", () => {
    const { core } = running();
    core.neverForThisApp();
    expect(core.neverApps).toEqual([]);
  });
});

describe("the ignored-apps file", () => {
  const DEBOUNCE = DEFAULT_DETECTION.debounceMs;
  let dir: string;
  let path: string;

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), "elegant-test-"));
    path = join(dir, "ignored-apps.json");
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  function running() {
    const engine = new FakeEngine();
    const core = new AppCore({
      engine,
      store: openStore(":memory:"),
      pipeline: fakePipeline(),
      extraIgnoredApps: ignoredAppsFile(path),
    });
    core.start();
    engine.emit({ type: "ready", version: "0.1.0" });
    const detect = (app: string, pid = 100) => {
      engine.emit({ type: "mic_in_use_started", app, pid });
      vi.advanceTimersByTime(DEBOUNCE);
    };
    return { core, detect };
  }

  it("is created empty and detects any app bundle name", () => {
    const { core, detect } = running();
    expect(JSON.parse(readFileSync(path, "utf8")).ignoredApps).toEqual([]);
    detect("Helium");
    expect(core.detectedMeeting?.app).toBe("Helium");
  });

  it("ignores an app added to the file without a restart", () => {
    const { core, detect } = running();
    detect("Whereby");
    expect(core.detectedMeeting?.app).toBe("Whereby");
    core.declinePrompt();

    writeFileSync(path, JSON.stringify({ ignoredApps: ["Whereby"] }));
    detect("Whereby", 200);
    expect(core.detectedMeeting).toBeUndefined();
  });

  it("does not detect built-in ignores", () => {
    const { core, detect } = running();
    detect("Siri");
    expect(core.detectedMeeting).toBeUndefined();
    detect("Dictation", 200);
    expect(core.detectedMeeting).toBeUndefined();
    detect("Wispr Flow", 300);
    expect(core.detectedMeeting).toBeUndefined();
  });

  it("keeps the last good list when the file is edited into something unreadable", () => {
    const { core, detect } = running();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(path, "{ not json");
    detect("zoom.us");
    expect(core.detectedMeeting?.app).toBe("zoom.us");
    expect(error).toHaveBeenCalled();
  });

  it("keeps an existing file as it is", () => {
    writeFileSync(path, JSON.stringify({ ignoredApps: ["Whereby"] }));
    const { core, detect } = running();
    detect("zoom.us");
    expect(core.detectedMeeting?.app).toBe("zoom.us");
    detect("Whereby", 200);
    expect(core.detectedMeeting?.app).toBe("zoom.us");
  });
});

describe("searching Meetings", () => {
  /** Stores a finished Meeting whose Transcript and Summary say the given things. */
  function stored(store: ReturnType<typeof openStore>, app: string, startedAt: string, said: string, summarised: string) {
    const id = store.createMeeting({ app, startedAt });
    store.saveTranscript(id, { segments: [{ start: 0, end: 2, speaker: "You", text: said }] });
    store.saveSummary(id, { tldr: summarised, participants: [{ speaker: "You", said: [summarised] }] });
    store.setMeetingState(id, "done");
    return id;
  }

  function withMeetings() {
    const store = openStore(":memory:");
    const budget = stored(store, "Slack", "2026-10-23T09:00:00.000Z", "The budget needs another review.", "Review the budget.");
    const launch = stored(store, "zoom.us", "2026-10-24T09:00:00.000Z", "We launch on Friday.", "Launch is planned.");
    const core = new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() });
    return { store, core, budget, launch };
  }

  it("finds a Meeting by a word in its Transcript", () => {
    const { core, budget } = withMeetings();
    expect(core.searchMeetings("another").map((m) => m.id)).toEqual([budget]);
  });

  it("finds a Meeting by a word only its Summary has", () => {
    const { core, launch } = withMeetings();
    expect(core.searchMeetings("planned").map((m) => m.id)).toEqual([launch]);
  });

  it("returns the Meeting's list entry, so a result can open its detail view", () => {
    const { core, launch } = withMeetings();
    expect(core.searchMeetings("friday")).toEqual([
      { id: launch, app: "zoom.us", startedAt: "2026-10-24T09:00:00.000Z", state: "done" },
    ]);
    expect(core.getMeeting(launch)).toMatchObject({ transcript: { segments: [{ text: "We launch on Friday." }] } });
  });

  it("ignores case, matches word forms and the start of a word, and needs every word", () => {
    const { core, budget, launch } = withMeetings();
    expect(core.searchMeetings("BUDGET").map((m) => m.id)).toEqual([budget]);
    expect(core.searchMeetings("launching").map((m) => m.id)).toEqual([launch]);
    expect(core.searchMeetings("budg").map((m) => m.id)).toEqual([budget]);
    expect(core.searchMeetings("budget friday")).toEqual([]);
  });

  it("lists matches newest first", () => {
    const { store, core, budget, launch } = withMeetings();
    const newest = stored(store, "Teams", "2026-10-25T09:00:00.000Z", "Back to the budget.", "Budget again.");
    expect(core.searchMeetings("budget").map((m) => m.id)).toEqual([newest, budget]);
    expect(core.searchMeetings("launch").map((m) => m.id)).toEqual([launch]);
  });

  it("matches nothing for a query with no words, and does not choke on search syntax", () => {
    const { core } = withMeetings();
    expect(core.searchMeetings("")).toEqual([]);
    expect(core.searchMeetings("   ")).toEqual([]);
    expect(core.searchMeetings('" OR * ( NEAR')).toEqual([]);
    expect(core.searchMeetings("budget's")).toEqual([]);
  });

  it("does not match the words that structure a Summary", () => {
    const { core } = withMeetings();
    expect(core.searchMeetings("said")).toEqual([]);
    expect(core.searchMeetings("speaker")).toEqual([]);
  });

  it("finds a Meeting once its Transcript and Summary have been produced by a Recording", async () => {
    const engine = new FakeEngine();
    const core = new AppCore({ engine, store: openStore(":memory:"), pipeline: fakePipeline() });
    core.start();
    engine.emit({ type: "recording_started", app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z" });
    expect(core.searchMeetings("skeleton")).toEqual([]);
    core.stopRecording();
    engine.emit({ type: "tracks_ready", micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav", micStartHostTime: 1, systemStartHostTime: 1 });
    await core.idle();

    expect(core.searchMeetings("skeleton").map((m) => m.app)).toEqual(["zoom.us"]);
    expect(core.searchMeetings("detection")).toHaveLength(1);
  });

  it("follows a regenerated Summary: the old text no longer matches", () => {
    const { store, core, launch } = withMeetings();
    store.saveSummary(launch, { tldr: "Shipping soon.", participants: [] });
    expect(core.searchMeetings("planned")).toEqual([]);
    expect(core.searchMeetings("shipping").map((m) => m.id)).toEqual([launch]);
    expect(core.searchMeetings("friday").map((m) => m.id)).toEqual([launch]);
  });

  it("no longer returns a Meeting once it is deleted", async () => {
    const { core, budget, launch } = withMeetings();
    await core.deleteMeeting(budget);

    expect(core.searchMeetings("budget")).toEqual([]);
    expect(core.searchMeetings("review")).toEqual([]);
    expect(core.searchMeetings("launch").map((m) => m.id)).toEqual([launch]);
  });
});

describe("show in Dock", () => {
  it("is off until the user turns it on, and each change is announced once", () => {
    const { core } = setup();
    const changes: boolean[] = [];
    core.onShowInDockChange((show) => changes.push(show));
    expect(core.showInDock).toBe(false);

    core.setShowInDock(true);
    core.setShowInDock(true);
    expect(core.showInDock).toBe(true);
    core.setShowInDock(false);
    expect(core.showInDock).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("is remembered by the store, so it survives a restart", () => {
    const store = openStore(":memory:");
    new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() }).setShowInDock(true);
    expect(new AppCore({ engine: new FakeEngine(), store, pipeline: fakePipeline() }).showInDock).toBe(true);
  });
});
