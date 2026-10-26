import { describe, expect, it } from "vitest";
import type { Transcript } from "./pipeline.js";
import { createSummariser } from "./summariser.js";
import { FakeModel } from "../testing/fake-model.js";
import { fixtureTranscript } from "../testing/fake-pipeline.js";

const goodReply = {
  tldr: "They agreed to ship the walking skeleton first.",
  participants: [
    { speaker: "You", said: ["Ship the walking skeleton first."] },
    { speaker: "Speaker 1", said: ["Fan out to detection and the window afterwards."] },
  ],
};

describe("summarising a Transcript", () => {
  it("produces a Summary in the documented shape", async () => {
    const summarise = createSummariser({ model: new FakeModel(() => goodReply) });
    expect(await summarise(fixtureTranscript)).toEqual(goodReply);
  });
});

describe("validating the model's output", () => {
  const summariseWith = (reply: unknown, transcript: Transcript = fixtureTranscript) =>
    createSummariser({ model: new FakeModel(() => reply), attempts: 1 })(transcript);

  it("rejects a Summary that names a speaker who is not in the Transcript", async () => {
    const invented = {
      tldr: "x",
      participants: [{ speaker: "Alice", said: ["Something."] }],
    };
    await expect(summariseWith(invented)).rejects.toThrow(/Alice/);
  });

  it.each([
    ["not JSON", "I cannot help with that"],
    ["no tldr", { participants: [] }],
    ["an empty tldr", { tldr: "  ", participants: [] }],
    ["participants that is not a list", { tldr: "x", participants: "You" }],
    ["said that is not a list of strings", { tldr: "x", participants: [{ speaker: "You", said: [1] }] }],
    ["the same speaker twice", {
      tldr: "x",
      participants: [{ speaker: "You", said: ["a"] }, { speaker: "You", said: ["b"] }],
    }],
  ])("rejects output with %s", async (_name, reply) => {
    await expect(summariseWith(reply)).rejects.toThrow();
  });

  it("tries again when the first output is rejected, and keeps the good one", async () => {
    const model = new FakeModel((_p, call) => (call === 1 ? { tldr: "x", participants: [{ speaker: "Bob", said: ["a"] }] } : goodReply));
    const summary = await createSummariser({ model })(fixtureTranscript);
    expect(summary).toEqual(goodReply);
    expect(model.prompts).toHaveLength(2);
  });

  it("gives up with the last problem after its attempts are used", async () => {
    const model = new FakeModel(() => ({ tldr: "x", participants: [{ speaker: "Bob", said: ["a"] }] }));
    await expect(createSummariser({ model, attempts: 3 })(fixtureTranscript)).rejects.toThrow(/Bob/);
    expect(model.prompts).toHaveLength(3);
  });
});

describe("a Transcript too long for one prompt", () => {
  const long: Transcript = {
    segments: Array.from({ length: 6 }, (_, i) => ({
      start: i * 10,
      end: i * 10 + 9,
      speaker: i % 2 === 0 ? "You" : "Speaker 1",
      text: `Point number ${i} is made here.`,
    })),
  };
  const chunkSize = 70; // each line is about 34 characters, so two segments per chunk

  /** Answers chunk prompts with one point per speaker seen in that chunk, and the final prompt with a TL;DR. */
  const chunkAwareModel = () =>
    new FakeModel((prompt) => {
      if (prompt.includes("\nPart 1: ")) return { tldr: "Overall: six points were made." };
      const speakers = ["You", "Speaker 1"].filter((s) => prompt.includes(`\n${s}: `));
      const part = /Point number (\d)/.exec(prompt)![1];
      return {
        tldr: `Part starting at point ${part}.`,
        participants: speakers.map((speaker) => ({ speaker, said: [`${speaker} in the part from point ${part}`] })),
      };
    });

  it("is split into chunks and still produces one Summary", async () => {
    const model = chunkAwareModel();
    const summary = await createSummariser({ model, maxChunkChars: chunkSize })(long);

    expect(model.prompts.length).toBeGreaterThan(2);
    expect(summary.tldr).toBe("Overall: six points were made.");
    expect(summary.participants.map((p) => p.speaker)).toEqual(["You", "Speaker 1"]);
    expect(summary.participants[0]!.said).toEqual([
      "You in the part from point 0",
      "You in the part from point 2",
      "You in the part from point 4",
    ]);
  });

  it("puts every segment in exactly one chunk, in order", async () => {
    const model = chunkAwareModel();
    await createSummariser({ model, maxChunkChars: chunkSize })(long);

    const chunkPrompts = model.prompts.slice(0, -1);
    for (const s of long.segments) {
      expect(chunkPrompts.filter((p) => p.includes(s.text))).toHaveLength(1);
    }
    const order = chunkPrompts.map((p) => /Point number (\d)/.exec(p)![1]);
    expect(order).toEqual([...order].sort());
  });

  it("makes a single model call when the Transcript fits in one chunk", async () => {
    const model = chunkAwareModel();
    await createSummariser({ model, maxChunkChars: 10_000 })(long);
    expect(model.prompts).toHaveLength(1);
  });

  it("still rejects a speaker that is not in the whole Transcript", async () => {
    const model = new FakeModel((prompt) =>
      prompt.includes("\nPart 1: ")
        ? { tldr: "x" }
        : { tldr: "x", participants: [{ speaker: "Alice", said: ["a"] }] },
    );
    await expect(createSummariser({ model, maxChunkChars: chunkSize, attempts: 1 })(long)).rejects.toThrow(/Alice/);
  });
});

describe("keeping to the documented shape", () => {
  it("drops fields the model adds beyond tldr, speaker and said", async () => {
    const reply = {
      tldr: "x",
      confidence: 0.9,
      participants: [{ speaker: "You", said: ["a"], mood: "upbeat" }],
    };
    const summary = await createSummariser({ model: new FakeModel(() => reply) })(fixtureTranscript);
    expect(summary).toEqual({ tldr: "x", participants: [{ speaker: "You", said: ["a"] }] });
  });
});

describe("a single segment longer than a chunk", () => {
  it("is split across chunks so no prompt exceeds the budget and none of its words are lost", async () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const monologue: Transcript = { segments: [{ start: 0, end: 60, speaker: "You", text: words.join(" ") }] };
    const model = new FakeModel((prompt) =>
      prompt.includes("\nPart 1: ")
        ? { tldr: "x" }
        : { tldr: "x", participants: [{ speaker: "You", said: ["a"] }] },
    );
    await createSummariser({ model, maxChunkChars: 100 })(monologue);

    const chunkPrompts = model.prompts.slice(0, -1);
    expect(chunkPrompts.length).toBeGreaterThan(1);
    const transcriptPart = (p: string) => p.slice(p.indexOf("Transcript:\n") + "Transcript:\n".length);
    for (const p of chunkPrompts) expect(transcriptPart(p).length).toBeLessThanOrEqual(100);
    const seen = chunkPrompts.flatMap((p) => transcriptPart(p).match(/word\d+/g) ?? []);
    expect(seen).toEqual(words);
  });
});
