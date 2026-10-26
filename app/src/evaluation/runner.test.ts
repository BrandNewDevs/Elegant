import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateFixture, validateFixture, type EvaluationFixture } from "./runner.js";
import { fakePipeline } from "../testing/fake-pipeline.js";

const fixture: EvaluationFixture = { id: "test", split: "tuning", synthetic: true,
  transcript: { segments: [{ start: 0, end: 1, speaker: "You", text: "Maybe Friday." }] },
  points: [{ id: "p", speaker: "You", text: "Friday is a proposal", refs: [0], critical: true }],
  questions: [{ id: "q", question: "Which day?", answer: "Friday", refs: [0], critical: true },
    { id: "f", question: "Was it agreed?", answer: "No", refs: [0], followUpTo: "q", critical: true }] };

describe("production-interface evaluation", () => {
  it("validates every committed fixture and its expected source references", () => {
    const dir = new URL("../../../evaluation/fixtures/", import.meta.url);
    const names = readdirSync(dir).filter(n => n.endsWith(".json"));
    expect(names).toHaveLength(8);
    for (const name of names) expect(validateFixture(JSON.parse(readFileSync(new URL(name, dir), "utf8"))).synthetic).toBe(true);
  });
  it("does not feed expected answers to generation and preserves follow-up context", async () => {
    const histories: unknown[] = [];
    const result = await evaluateFixture(fixture, { ...fakePipeline(), answer: async (_t, question, history) => {
      histories.push(history);
      return { text: question === "Which day?" ? "Friday was proposed." : "No agreement.", refs: [0], sufficient: true };
    } }, () => 0);
    expect(result.error).toBeUndefined();
    expect(histories).toEqual([[], [{ question: "Which day?", answer: { text: "Friday was proposed.", refs: [0], sufficient: true } }]]);
  });
  it("records failures and missing chat without reporting them as successful answers", async () => {
    const result = await evaluateFixture(fixture, { summarise: async () => { throw new Error("model missing"); } }, () => 0);
    expect(result.error).toBe("model missing");
    expect(result.summary).toBeUndefined();
    expect(result.chat.every(q => q.skipped && !q.answer)).toBe(true);
  });
  it("rejects unsupported expected attribution before generation", () => {
    expect(() => validateFixture({ ...fixture, points: [{ ...fixture.points[0], speaker: "invented" }] })).toThrow("Invalid expected point");
    expect(() => validateFixture({ ...fixture, questions: [{ ...fixture.questions[0], refs: [20] }] })).toThrow("Invalid expected question");
  });
});
