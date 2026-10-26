import { describe, expect, it } from "vitest";
import { createGroundedSummariser, SUMMARY_PROMPT_VERSION } from "./grounded-summariser.js";
import { requestBytes } from "./model-request.js";
import type { Transcript } from "./pipeline.js";
import type { TextModel, TextRequest } from "./language-model.js";

interface Piece { id: string; ref: number; part: number; speaker: string; text: string }
interface Fact { id: number; speaker: string; text: string; kind: string; sourceIds: string[]; covers?: number[] }
interface Payload { primary?: Piece[]; sources?: Piece[]; candidates?: Fact[]; totalFacts?: number; otherFactsRetained?: number }
const data = (request: TextRequest): Payload => (JSON.parse(request.messages.at(-1)!.content) as { data: Payload }).data;
const prefix = (text: string) => text.split(" | ")[0]!;
function original(text: string) { return `${text} | ` + "The surrounding discussion is original evidence and remains available without being shortened. ".repeat(9); }
function uniqueCommitments(): Transcript { return { segments: Array.from({ length: 9 }, (_, index) => ({
  start: index * 30, end: index * 30 + 20, speaker: "You", text: original(`I will complete Task_${index} by day ${index + 1}.`),
})) }; }
function adapter(reduce: (facts: Fact[], sources: Piece[]) => Fact[] = facts => facts.map(fact => ({ ...fact, covers: [fact.id] }))) {
  const requests: TextRequest[] = [];
  const model: TextModel = { async complete(request) {
    requests.push(request);
    const input = data(request);
    let output: unknown;
    if (input.primary) output = { facts: input.primary.filter(piece => piece.part === 0).map(piece => ({
      speaker: piece.speaker, text: prefix(piece.text), kind: /propose|suggest/i.test(piece.text) ? "proposal" : /final decision/i.test(piece.text) ? "decision" : "commitment", sourceIds: [piece.id],
    })) };
    else if ("facts" in (request.schema as { properties: object }).properties) output = { facts: reduce(input.candidates!, input.sources!) };
    else output = { tldr: "The selected commitments and final decisions remain supported by the original discussion.", sourceIds: input.sources!.map(piece => piece.id) };
    return { text: JSON.stringify(output), metadata: { model: "coverage:test", elapsedMs: 1 } };
  } };
  return { model, requests };
}

describe("complete long Summary coverage", () => {
  it("retains nine distinct commitments whose combined original evidence cannot fit one request", async () => {
    const transcript = uniqueCommitments();
    const { model, requests } = adapter();
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants[0]!.said).toEqual(transcript.segments.map(segment => prefix(segment.text)));
    expect(result.evidence!.participants[0]!.said).toEqual(transcript.segments.map((_, index) => [index]));
    expect(result.generation!.promptVersion).toBe(SUMMARY_PROMPT_VERSION);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    const final = data(requests.at(-1)!);
    expect(final.totalFacts).toBe(9);
    expect(final.otherFactsRetained).toBeGreaterThan(0);
    for (const fact of final.candidates!) expect(fact.sourceIds.every(id => final.sources!.some(piece => piece.id === id))).toBe(true);
    expect(requests.filter(request => "facts" in (request.schema as { properties: object }).properties && data(request).candidates).length).toBeGreaterThan(1);
  });

  it("merges interleaved repetitions while retaining every distinct case-sensitive topic", async () => {
    const topics = ["Branch Alpha", "Branch alpha", "Branch Beta"];
    const transcript: Transcript = { segments: Array.from({ length: 12 }, (_, index) => ({ start: index * 30, end: index * 30 + 20,
      speaker: "You", text: original(`${topics[index % 3]} must remain local.`) })) };
    const { model, requests } = adapter(facts => {
      const groups = new Map<string, Fact[]>();
      for (const fact of facts) groups.set(fact.text, [...(groups.get(fact.text) ?? []), fact]);
      return [...groups.values()].map(group => ({ ...group.at(-1)!, covers: group.map(fact => fact.id) }));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants[0]!.said).toHaveLength(3);
    expect(new Set(result.participants[0]!.said)).toEqual(new Set(topics.map(topic => `${topic} must remain local.`)));
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("retains the proposer and corrector separately when another speaker changes a decision", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.speaker = "Speaker 1";
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    let compared = false;
    const { model } = adapter(facts => {
      const proposal = facts.find(fact => fact.text.includes("propose launching"));
      const decision = facts.find(fact => fact.text.includes("Final decision"));
      if (proposal && decision) compared = true;
      return facts.map(fact => ({ ...fact, covers: [fact.id], ...(proposal && decision && fact.id === proposal.id ? {
        text: "Proposed Monday; Speaker 1 later set Friday instead.", sourceIds: [...proposal.sourceIds, ...decision.sourceIds],
      } : {}) }));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(compared).toBe(true);
    const proposer = result.participants.find(participant => participant.speaker === "You")!;
    const corrector = result.participants.find(participant => participant.speaker === "Speaker 1")!;
    expect(proposer.said).toContain("Proposed Monday; Speaker 1 later set Friday instead.");
    expect(corrector.said).toEqual(["Final decision: launch Friday instead of Monday."]);
    const proposerEvidence = result.evidence!.participants.find(participant => participant.speaker === "You")!;
    expect(proposerEvidence.said[proposer.said.indexOf("Proposed Monday; Speaker 1 later set Friday instead.")]).toEqual([0, 8]);
    expect(result.evidence!.participants.find(participant => participant.speaker === "Speaker 1")!.said).toEqual([[8]]);
  });

  it("rejects missing candidate coverage rather than publishing a shortened partial Summary", async () => {
    const { model, requests } = adapter(facts => facts.slice(0, -1).map(fact => ({ ...fact, covers: [fact.id] })));
    await expect(createGroundedSummariser({ model, attempts: 2 })(uniqueCommitments())).rejects.toThrow("Every input candidate must be represented");
    expect(requests.every(request => !((request.schema as { properties: object }).properties && "tldr" in (request.schema as { properties: object }).properties))).toBe(true);
  });

  it("never publishes a partially compared round after the deadline", async () => {
    const inner = adapter();
    const model: TextModel = { async complete(request) {
      if (data(request).candidates) await new Promise(resolve => setTimeout(resolve, 20));
      return inner.model.complete(request);
    } };
    await expect(createGroundedSummariser({ model, deadlineMs: 10 })(uniqueCommitments())).rejects.toThrow("deadline");
    expect(inner.requests.every(request => !("tldr" in (request.schema as { properties: object }).properties))).toBe(true);
  });
});
