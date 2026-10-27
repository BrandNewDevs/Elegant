import { describe, expect, it } from "vitest";
import { originalSentences, parseSentenceClassifications } from "./sentence-claims.js";
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
    const result = parseSentenceClassifications(JSON.stringify({ classifications: Object.fromEntries(primary.map((sentence, index) => [sentence.id, kinds[index]])) }), primary, lookup);
    expect(result.map(fact => fact.text)).toEqual(primary.map(sentence => sentence.text));
    expect(result.map(fact => fact.kind)).toEqual(kinds);
    expect(result.map(fact => fact.refs)).toEqual([[178], [178], [178], [182], [182]]);
    expect(result.every(fact => fact.speaker === "Speaker 2")).toBe(true);
    expect(result.every(fact => sources.some(source => source.text.includes(fact.text)))).toBe(true);
  });

  it("can omit an explicitly classified procedural sentence without losing another claim", () => {
    const primary = originalSentences(sources.slice(1));
    const result = parseSentenceClassifications(JSON.stringify({ classifications: { [primary[0]!.id]: "procedure", [primary[1]!.id]: "unresolved" } }), primary, lookup);
    expect(result.map(fact => fact.text)).toEqual(["No one has measured the M4 memory peak yet."]);
  });

  it("rejects generated prose and attribution outside the classification contract", () => {
    const primary = originalSentences(sources);
    const classifications = Object.fromEntries(primary.map(sentence => [sentence.id, "update"]));
    for (const extra of [{ text: "Invented outcome" }, { speaker: "Someone else" }, { refs: [0] }]) {
      expect(() => parseSentenceClassifications(JSON.stringify({ classifications, ...extra }), primary, lookup))
        .toThrow("Return only classifications");
    }
  });

  it.each(["missing", "unknown", "context", "bad-kind"])("rejects %s classifications instead of silently losing source content", invalid => {
    const primary = originalSentences(sources.slice(1));
    const classifications: Record<string, unknown> = Object.fromEntries(primary.map(sentence => [sentence.id, "update"]));
    if (invalid === "missing") delete classifications[primary[1]!.id];
    else if (invalid === "unknown") classifications.invented = "update";
    else if (invalid === "context") classifications["178:0:0"] = "update";
    else classifications[primary[0]!.id] = "approved";
    expect(() => parseSentenceClassifications(JSON.stringify({ classifications }), primary, lookup)).toThrow();
  });
});
