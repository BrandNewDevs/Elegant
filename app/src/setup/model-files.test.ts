import { mkdirSync, mkdtempSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelFiles, removeModelFiles } from "./model-files.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elegant-models-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Lays out what the engine leaves: WhisperKit's variant and tokenizer, and SpeakerKit's models. */
function download(bytes: { speech?: number; speaker?: number } = { speech: 600, speaker: 11 }) {
  if (bytes.speech) {
    mkdirSync(join(dir, "models/argmaxinc/whisperkit-coreml/openai_whisper-tiny"), { recursive: true });
    writeFileSync(join(dir, "models/argmaxinc/whisperkit-coreml/openai_whisper-tiny/weights.bin"), Buffer.alloc(bytes.speech - 5));
    mkdirSync(join(dir, "models/openai/whisper-large-v3"), { recursive: true });
    writeFileSync(join(dir, "models/openai/whisper-large-v3/tokenizer.json"), Buffer.alloc(5));
  }
  if (bytes.speaker) {
    mkdirSync(join(dir, "models/argmaxinc/speakerkit-coreml/speaker_embedder"), { recursive: true });
    writeFileSync(join(dir, "models/argmaxinc/speakerkit-coreml/speaker_embedder/weights.bin"), Buffer.alloc(bytes.speaker));
  }
}

describe("model files on disk", () => {
  it("reports each kind's size, counting the tokenizer with the speech model", async () => {
    download();
    expect(await modelFiles(dir)).toEqual([
      { kind: "speech", present: true, bytes: 600 },
      { kind: "speaker", present: true, bytes: 11 },
    ]);
  });

  it("reports nothing present before anything is downloaded, or when the folder does not exist", async () => {
    expect(await modelFiles(join(dir, "nope"))).toEqual([
      { kind: "speech", present: false, bytes: 0 },
      { kind: "speaker", present: false, bytes: 0 },
    ]);
    download({ speaker: 11 });
    expect((await modelFiles(dir)).map((f) => f.present)).toEqual([false, true]);
  });

  it("does not count a file reached through a link", async () => {
    download({ speaker: 11 });
    writeFileSync(join(dir, "outside.bin"), Buffer.alloc(1000));
    symlinkSync(join(dir, "outside.bin"), join(dir, "models/argmaxinc/speakerkit-coreml/link.bin"));
    expect((await modelFiles(dir))[1]).toMatchObject({ present: true, bytes: 11 });
  });

  it("removes one kind and leaves the other", async () => {
    download();
    await removeModelFiles(dir, "speech");
    expect(existsSync(join(dir, "models/argmaxinc/whisperkit-coreml"))).toBe(false);
    expect(existsSync(join(dir, "models/openai"))).toBe(false);
    expect(await modelFiles(dir)).toEqual([
      { kind: "speech", present: false, bytes: 0 },
      { kind: "speaker", present: true, bytes: 11 },
    ]);
  });

  it("removing what is not there is not an error", async () => {
    await expect(removeModelFiles(dir, "speaker")).resolves.toBeUndefined();
  });
});
