import { describe, expect, it } from "vitest";
import { SENTENCE_KINDS, originalSentences, parseSentenceClassifications, sentenceClassificationSchema, isBareAgendaHeading } from "./sentence-claims.js";
import type { SourcePiece } from "./grounded-format.js";

const sources: SourcePiece[] = [
  { id: "178:0", ref: 178, part: 0, start: 0, end: 10, speaker: "Speaker 2",
    text: "The final offline review failed for PDF. Markdown passed that check. These are synthetic outcomes, not actual app measurements." },
  { id: "182:0", ref: 182, part: 0, start: 10, end: 20, speaker: "Speaker 2",
    text: "I will rerun the offline workflow on Thursday. No one has measured the M4 memory peak yet." },
];
const lookup = new Map(sources.map(source => [source.id, source]));

describe("original sentence extraction contract", () => {
  it("recognizes only bare numbered topic headings as procedural", () => {
    expect(isBareAgendaHeading("Review round 22, topic permissions.")).toBe(true);
    expect(isBareAgendaHeading("Review round 3, topic system audio settings.")).toBe(true);
    expect(isBareAgendaHeading("Review round 22, topic packaging has no assigned owner.")).toBe(false);
    expect(isBareAgendaHeading("Review round 22, topic permissions. The new permission request is ready.")).toBe(false);
  });
  it("retains independent outcomes, commitments and uncertainty as unchanged original clauses", () => {
    const primary = originalSentences(sources);
    const kinds = ["update", "update", "update", "commitment", "unresolved"];
    const result = parseSentenceClassifications(JSON.stringify({ classifications: [5, 5, 5, 2, 4] }), primary, lookup);
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
    expect(schema.properties.classifications.items).toEqual({ type: "integer", enum: [0, 1, 2, 3, 4, 5, 6] });
    expect(SENTENCE_KINDS).toEqual(["proposal", "decision", "commitment", "disagreement", "unresolved", "update", "procedure"]);
    expect(Object.isFrozen(SENTENCE_KINDS)).toBe(true);
    expect(JSON.stringify(schema).match(/"enum"/g)).toHaveLength(1);
  });

  it("decodes all seven integer positions without changing original words or ownership", () => {
    const source: SourcePiece = { ...sources[0]!, text: "Proposal clause. Decision clause. Commitment clause. Disagreement clause. Unresolved clause. Update clause. Procedure clause." };
    const primary = originalSentences([source]);
    expect(primary).toHaveLength(7);
    const facts = parseSentenceClassifications(JSON.stringify({ classifications: [0, 1, 2, 3, 4, 5, 6] }), primary, new Map([[source.id, source]]));
    expect(facts.map(fact => fact.kind)).toEqual(["proposal", "decision", "commitment", "disagreement", "unresolved", "update"]);
    expect(facts.map(fact => fact.text)).toEqual(primary.slice(0, 6).map(sentence => sentence.text));
    expect(facts.every(fact => fact.speaker === source.speaker && fact.refs.length === 1 && fact.refs[0] === source.ref)).toBe(true);
  });

  it("can omit an explicitly classified procedural sentence without losing another claim", () => {
    const primary = originalSentences(sources.slice(1));
    const result = parseSentenceClassifications(JSON.stringify({ classifications: [6, 4] }), primary, lookup);
    expect(result.map(fact => fact.text)).toEqual(["No one has measured the M4 memory peak yet."]);
  });

  it.each([-1, 7, 1.5, "5", true, null])("rejects invalid integer classification code %j", code => {
    const primary = originalSentences(sources.slice(1));
    expect(() => parseSentenceClassifications(JSON.stringify({ classifications: [code, 4] }), primary, lookup))
      .toThrow("Use a supplied integer sentence kind code");
  });

  it("rejects generated prose and attribution outside the classification contract", () => {
    const primary = originalSentences(sources);
    const classifications = primary.map(() => 5);
    for (const extra of [{ text: "Invented outcome" }, { speaker: "Someone else" }, { refs: [0] }]) {
      expect(() => parseSentenceClassifications(JSON.stringify({ classifications, ...extra }), primary, lookup))
        .toThrow("Return only classifications");
    }
  });

  it.each(["missing", "extra", "object", "bad-kind"])("rejects %s classifications instead of silently losing source content", invalid => {
    const primary = originalSentences(sources.slice(1));
    const classifications: unknown[] = primary.map(() => 5);
    if (invalid === "missing") classifications.pop();
    else if (invalid === "extra") classifications.push(5);
    else if (invalid === "bad-kind") classifications[0] = "approved";
    const value = invalid === "object" ? { [primary[0]!.id]: "update", [primary[1]!.id]: "update" } : classifications;
    expect(() => parseSentenceClassifications(JSON.stringify({ classifications: value }), primary, lookup)).toThrow();
  });
});
