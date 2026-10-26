import { describe, expect, it, vi } from "vitest";
import { FakeEngine } from "../testing/fake-engine.js";
import { fixtureTranscript } from "../testing/fake-pipeline.js";
import { createEngineTranscriber } from "./engine-transcriber.js";

const tracks = { micPath: "/tmp/mic.wav", systemPath: "/tmp/system.wav" };
const options = { model: "tiny.en", modelsDirectory: "/tmp/models" };

function setup() {
  const engine = new FakeEngine();
  const transcribe = createEngineTranscriber(engine, options);
  const lastCommand = () => engine.commands.at(-1) as Extract<(typeof engine.commands)[number], { type: "transcribe" }>;
  return { engine, transcribe, lastCommand };
}

describe("the engine transcriber", () => {
  it("asks the engine to transcribe the tracks with the configured model", () => {
    const { transcribe, lastCommand } = setup();
    void transcribe(tracks).catch(() => {});
    expect(lastCommand()).toMatchObject({ type: "transcribe", ...tracks, ...options });
  });

  it("resolves with the segments the engine sends back", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcript_ready", id: lastCommand().id, segments: fixtureTranscript.segments });
    const release = engine.commands.at(-1);
    expect(release?.type).toBe("release_models");
    if (release?.type === "release_models") engine.emit({ type: "models_released", id: release.id });
    await expect(result).resolves.toEqual(fixtureTranscript);
  });

  it("rejects with the engine's reason when transcription fails", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcription_failed", id: lastCommand().id, message: "the speech model could not be downloaded" });
    await expect(result).rejects.toThrow("the speech model could not be downloaded");
  });

  it("matches each answer to its own request", async () => {
    const { engine, transcribe } = setup();
    const first = transcribe(tracks);
    const second = transcribe(tracks);
    const [a, b] = engine.commands.map((c) => (c as { id: string }).id);
    engine.emit({ type: "transcription_failed", id: b!, message: "second failed" });
    engine.emit({ type: "transcript_ready", id: a!, segments: [] });
    await expect(second).rejects.toThrow("second failed");
    const release = engine.commands.at(-1);
    if (release?.type === "release_models") engine.emit({ type: "models_released", id: release.id });
    await expect(first).resolves.toEqual({ segments: [] });
  });

  it("ignores an answer to a request it never made", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcript_ready", id: "someone-else", segments: [] });
    engine.emit({ type: "transcript_ready", id: lastCommand().id, segments: fixtureTranscript.segments });
    const release = engine.commands.at(-1);
    expect(release?.type).toBe("release_models");
    if (release?.type === "release_models") engine.emit({ type: "models_released", id: release.id });
    await expect(result).resolves.toEqual(fixtureTranscript);
  });

  it("rejects when the engine stops before answering", async () => {
    const { engine, transcribe } = setup();
    const result = transcribe(tracks);
    engine.exit();
    await expect(result).rejects.toThrow(/engine stopped/);
  });
});


describe("speech-model release before Summary generation", () => {
  it("does not resolve until its own release acknowledgement, and ignores duplicate Transcripts", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    const id = lastCommand().id;
    const resolved = vi.fn();
    void result.then(resolved);
    engine.emit({ type: "transcript_ready", id, segments: fixtureTranscript.segments });
    const release = engine.commands.at(-1);
    expect(release?.type).toBe("release_models");
    engine.emit({ type: "transcript_ready", id, segments: [] });
    engine.emit({ type: "models_released", id: "unrelated" });
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(engine.commands).toHaveLength(2);
    if (release?.type === "release_models") engine.emit({ type: "models_released", id: release.id });
    await expect(result).resolves.toEqual(fixtureTranscript);
  });

  it("rejects an unload failure rather than starting text generation", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcript_ready", id: lastCommand().id, segments: [] });
    const release = engine.commands.at(-1);
    if (release?.type === "release_models") engine.emit({ type: "model_release_failed", id: release.id, message: "busy" });
    await expect(result).rejects.toThrow(/could not be released: busy/);
  });

  it("rejects engine exit while waiting for release", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcript_ready", id: lastCommand().id, segments: [] });
    engine.exit();
    await expect(result).rejects.toThrow(/engine stopped/);
  });

  it("times out a missing release acknowledgement and ignores a late result", async () => {
    vi.useFakeTimers();
    try {
      const engine = new FakeEngine();
      const transcribe = createEngineTranscriber(engine, { ...options, releaseTimeoutMs: 100 });
      const result = transcribe(tracks);
      const command = engine.commands.at(-1);
      if (command?.type === "transcribe") engine.emit({ type: "transcript_ready", id: command.id, segments: [] });
      const rejected = expect(result).rejects.toThrow(/did not confirm speech-model release/);
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      const release = engine.commands.at(-1);
      if (release?.type === "release_models") engine.emit({ type: "models_released", id: release.id });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
