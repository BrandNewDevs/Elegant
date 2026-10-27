import { describe, expect, it } from "vitest";
import { originalSentences, parseSentenceClassifications, sentenceClassificationSchema } from "./sentence-claims.js";
import type { SourcePiece } from "./grounded-format.js";

const sources: SourcePiece[] = [
  { id: "178:0", ref: 178, part: 0, start: 0, end: 10, speaker: "Speaker 2",
    text: "The final offline review failed for PDF. Markdown passed that check. These are synthetic outcomes, not actual app measurements." },
  { id: "182:0", ref: 182, part: 0, start: 10, end: 20, speaker: "Speaker 2",
    text: "I will rerun the offline workflow on Thursday. No one has measured the M4 memory peak yet." },
];
const lookup = new Map(sources.map(source => [source.id, source]));

describe("original sentence extraction contract", () => {
  it("retains independent outcomes, commitments and uncertainty as unchanged original clauses", () => {
    const primary = originalSentences(sources);
    const kinds = ["update", "update", "update", "commitment", "unresolved"];
    const result = parseSentenceClassifications(JSON.stringify({ classifications: kinds }), primary, lookup);
    expect(result.map(fact => fact.text)).toEqual(primary.map(sentence => sentence.text));
    expect(result.map(fact => fact.kind)).toEqual(kinds);
    expect(result.map(fact => fact.refs)).toEqual([[178], [178], [178], [182], [182]]);
    expect(result.every(fact => fact.speaker === "Speaker 2")).toBe(true);
    expect(result.every(fact => sources.some(source => source.text.includes(fact.text)))).toBe(true);
  });

  it("shares one kind definition while requiring exactly one label per original sentence", () => {
    const primary = originalSentences(sources);
    const schema = sentenceClassificationSchema(primary);
    expect(schema.properties.classifications.minItems).toBe(primary.length);
    expect(schema.properties.classifications.maxItems).toBe(primary.length);
    expect(schema.properties.classifications.items.enum).toContain("unresolved");
    expect(schema.properties.classifications.items.enum).toContain("procedure");
    expect(JSON.stringify(schema).match(/"procedure"/g)).toHaveLength(1);
  });

  it("can omit an explicitly classified procedural sentence without losing another claim", () => {
    const primary = originalSentences(sources.slice(1));
    const result = parseSentenceClassifications(JSON.stringify({ classifications: ["procedure", "unresolved"] }), primary, lookup);
    expect(result.map(fact => fact.text)).toEqual(["No one has measured the M4 memory peak yet."]);
  });

  it("rejects generated prose and attribution outside the classification contract", () => {
    const primary = originalSentences(sources);
    const classifications = primary.map(() => "update");
    for (const extra of [{ text: "Invented outcome" }, { speaker: "Someone else" }, { refs: [0] }]) {
      expect(() => parseSentenceClassifications(JSON.stringify({ classifications, ...extra }), primary, lookup))
        .toThrow("Return only classifications");
    }
  });

  it.each(["missing", "extra", "object", "bad-kind"])("rejects %s classifications instead of silently losing source content", invalid => {
    const primary = originalSentences(sources.slice(1));
    const classifications: unknown[] = primary.map(() => "update");
    if (invalid === "missing") classifications.pop();
    else if (invalid === "extra") classifications.push("update");
    else if (invalid === "bad-kind") classifications[0] = "approved";
    const value = invalid === "object" ? { [primary[0]!.id]: "update", [primary[1]!.id]: "update" } : classifications;
    expect(() => parseSentenceClassifications(JSON.stringify({ classifications: value }), primary, lookup)).toThrow();
  });
});
