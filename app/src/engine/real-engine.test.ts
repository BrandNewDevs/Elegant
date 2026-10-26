import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { until } from "../testing/until.js";
import { ProcessEngine } from "./process-engine.js";
import type { EngineEvent, EngineExit } from "./protocol.js";

// Built by `pnpm run build:engine`, which `pnpm test` runs first.
const engineBinary = fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

describe("the real Swift engine", () => {
  it("reports ready, reports a failure when asked to stop a recording that never started, and exits on shutdown", async () => {
    expect(existsSync(engineBinary), `engine not built; run: pnpm run build:engine`).toBe(true);

    const engine = new ProcessEngine({ command: engineBinary });
    const events: EngineEvent[] = [];
    const exits: EngineExit[] = [];
    engine.onEvent((e) => events.push(e));
    engine.onExit((x) => exits.push(x));
    engine.start();

    await until(() => events.length >= 1);
    expect(events[0]).toEqual({ type: "ready", version: "0.1.0" });

    engine.send({ type: "stop_recording" });
    await until(() => events.length >= 2);
    expect(events[1]).toMatchObject({ type: "recording_failed", message: expect.stringContaining("no recording is in progress") });

    await engine.stop();
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });
});

/** A 16 kHz mono 16-bit WAV of silence. */
function silentWav(seconds: number): Buffer {
  const data = Buffer.alloc(16_000 * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("transcription in the real Swift engine", () => {
  // These need no speech model: silence never reaches it, and an unreadable file fails first.
  async function ask(command: { micPath: string; systemPath: string }): Promise<EngineEvent> {
    const engine = new ProcessEngine({ command: engineBinary });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.start();
    await until(() => events.length >= 1);
    engine.send({ type: "transcribe", id: "t1", model: "tiny.en", modelsDirectory: join(tmpdir(), "no-models-needed"), ...command });
    await until(() => events.some((e) => e.type === "transcript_ready" || e.type === "transcription_failed"));
    await engine.stop();
    return events.find((e) => e.type === "transcript_ready" || e.type === "transcription_failed")!;
  }

  it("returns an empty Transcript for a Recording with no speech", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcribe-test-"));
    try {
      writeFileSync(join(dir, "mic.wav"), silentWav(3));
      writeFileSync(join(dir, "system.wav"), silentWav(3));
      expect(await ask({ micPath: join(dir, "mic.wav"), systemPath: join(dir, "system.wav") })).toEqual({
        type: "transcript_ready",
        id: "t1",
        segments: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a failure, naming the file, when a track cannot be read", async () => {
    const event = await ask({ micPath: "/nonexistent/mic.wav", systemPath: "/nonexistent/system.wav" });
    expect(event).toMatchObject({ type: "transcription_failed", id: "t1", message: expect.stringContaining("/nonexistent/mic.wav") });
  });
});

