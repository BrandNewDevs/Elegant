import { describe, expect, it } from "vitest";
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
    await expect(first).resolves.toEqual({ segments: [] });
  });

  it("ignores an answer to a request it never made", async () => {
    const { engine, transcribe, lastCommand } = setup();
    const result = transcribe(tracks);
    engine.emit({ type: "transcript_ready", id: "someone-else", segments: [] });
    engine.emit({ type: "transcript_ready", id: lastCommand().id, segments: fixtureTranscript.segments });
    await expect(result).resolves.toEqual(fixtureTranscript);
  });

  it("rejects when the engine stops before answering", async () => {
    const { engine, transcribe } = setup();
    const result = transcribe(tracks);
    engine.exit();
    await expect(result).rejects.toThrow(/engine stopped/);
  });
});
