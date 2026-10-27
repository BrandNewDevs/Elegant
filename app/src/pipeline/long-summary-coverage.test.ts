import { describe, expect, it } from "vitest";
import { createGroundedSummariser, SUMMARY_PROMPT_VERSION } from "./grounded-summariser.js";
import { requestBytes } from "./model-request.js";
import type { Transcript } from "./pipeline.js";
import type { TextModel, TextRequest } from "./language-model.js";

interface Piece { id: string; ref: number; part: number; speaker: string; text: string }
interface Fact { id: number; speaker: string; text: string; kind: string; sourceIds: string[]; covers?: number[] }
interface Payload { requiredCoverage?: Record<string, number[]>; primary?: Piece[]; sources?: Piece[]; candidates?: Fact[]; totalFacts?: number; otherFactsRetained?: number }
const data = (request: TextRequest): Payload => (JSON.parse(request.messages.at(-1)!.content) as { data: Payload }).data;
const prefix = (text: string) => text.split(" | ")[0]!;
function original(text: string) { return `${text} | ` + "The surrounding discussion is original evidence and remains available without being shortened. ".repeat(9); }
function uniqueCommitments(): Transcript { return { segments: Array.from({ length: 9 }, (_, index) => ({
  start: index * 30, end: index * 30 + 20, speaker: "You", text: original(`I will complete Task_${index} by day ${index + 1}.`),
})) }; }
function adapter(reduce: (facts: Fact[], sources: Piece[], request: TextRequest) => Fact[] = facts => facts.map(fact => ({ ...fact, covers: [fact.id] }))) {
  const requests: TextRequest[] = [];
  const model: TextModel = { async complete(request) {
    requests.push(request);
    const input = data(request);
    let output: unknown;
    if (input.primary) output = { facts: input.primary.filter(piece => piece.part === 0).map(piece => ({
      speaker: piece.speaker, text: prefix(piece.text), kind: /propose|suggest/i.test(piece.text) ? "proposal" : /final decision/i.test(piece.text) ? "decision" : "commitment", sourceIds: [piece.id],
    })) };
    else if (input.candidates && !("tldr" in (request.schema as { properties: object }).properties)) output = Object.fromEntries(reduce(input.candidates, input.sources!, request).flatMap(fact => (fact.covers ?? []).map(id => [String(id), Math.min(...fact.covers!)])));
    else output = { tldr: "The selected commitments and final decisions remain supported by the original discussion.", sourceIds: input.sources!.map(piece => piece.id) };
    return { text: JSON.stringify(output), metadata: { model: "coverage:test", elapsedMs: 1 } };
  } };
  return { model, requests };
}

function assignmentAdapter(assign: (facts: Fact[], request: TextRequest) => unknown) {
  const inner = adapter();
  const requests: TextRequest[] = [];
  const model: TextModel = { async complete(request) {
    requests.push(request);
    const input = data(request);
    if (input.candidates && !("tldr" in (request.schema as { properties: object }).properties)) {
      return { text: JSON.stringify(assign(input.candidates, request)), metadata: { model: "assignment:test", elapsedMs: 1 } };
    }
    return inner.model.complete(request);
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
    expect(requests.filter(request => !("tldr" in (request.schema as { properties: object }).properties) && data(request).candidates).length).toBeGreaterThan(1);
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
    expect(new Set(result.participants[0]!.said.flatMap(point => point.split("\n")))).toEqual(new Set(topics.map(topic => `${topic} must remain local.`)));
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("retains the proposer and corrector separately when another speaker changes a decision", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.speaker = "Speaker 1";
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    let compared = false;
    const { model } = adapter((facts, sources) => {
      const proposal = facts.find(fact => fact.text.includes("propose launching"));
      const decision = sources.find(source => source.text.includes("Final decision"));
      if (proposal && decision) compared = true;
      return facts.map(fact => ({ ...fact, covers: [fact.id], ...(proposal && decision && fact.id === proposal.id ? {
        text: "Proposed Monday; Speaker 1 later set Friday instead.", sourceIds: [...proposal.sourceIds, decision.id],
      } : {}) }));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(compared).toBe(true);
    const proposer = result.participants.find(participant => participant.speaker === "You")!;
    const corrector = result.participants.find(participant => participant.speaker === "Speaker 1")!;
    expect(proposer.said).toContain("I propose launching on Monday.");
    expect(corrector.said).toEqual(["Final decision: launch Friday instead of Monday."]);
    const proposerEvidence = result.evidence!.participants.find(participant => participant.speaker === "You")!;
    expect(proposerEvidence.said[proposer.said.indexOf("I propose launching on Monday.")]).toEqual([0]);
    expect(result.evidence!.participants.find(participant => participant.speaker === "Speaker 1")!.said).toEqual([[8]]);
  });

  it("skips guaranteed singleton assignments even when a topic group contains three speakers' context", async () => {
    const transcript = uniqueCommitments();
    const speakers = ["You", "Speaker 1", "Speaker 2"];
    transcript.segments.forEach((segment, index) => {
      segment.speaker = speakers[Math.floor(index / 3)]!;
      segment.text = original(`Topic_${index % 3}: distinct obligation_${index}.`);
    });
    let mixedContextCalls = 0;
    const { model, requests } = adapter((facts, sources, request) => {
      const owners = [...new Set(facts.map(fact => fact.speaker))];
      // Models that focus on the first actor lose the others in a mixed request.
      // Speaker-scoped requests must retain them all without weakening covers.
      const output = facts.filter(fact => fact.speaker === owners[0]);
      expect(owners).toHaveLength(1);
      if (new Set(sources.map(source => source.speaker)).size > 1) mixedContextCalls++;
      const schema = request.schema as { properties: Record<string, { enum: number[] }>; required: string[] };
      expect(schema.required).toEqual(facts.map(fact => String(fact.id)));
      expect(Object.keys(schema.properties)).toEqual(schema.required);
      return output.map(fact => ({ ...fact, covers: [fact.id] }));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(mixedContextCalls).toBe(0);
    expect(requests.filter(request => data(request).candidates && !("tldr" in (request.schema as { properties: object }).properties))).toHaveLength(0);
    for (const speaker of speakers) {
      expect(result.participants.find(participant => participant.speaker === speaker)!.said)
        .toEqual(transcript.segments.filter(segment => segment.speaker === speaker).map(segment => prefix(segment.text)));
    }
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("reuses validated unchanged grouping requests when another topic needs another comparison round", async () => {
    const transcript: Transcript = { segments: Array.from({ length: 18 }, (_, index) => ({
      start: index * 20, end: index * 20 + 10, speaker: "You",
      text: original(`Topic_${Math.floor(index / 6)} distinct obligation_${index}.`),
    })) };
    const requestsByTopic = new Map<string, string[]>();
    const { model, requests } = assignmentAdapter((facts, request) => {
      const topic = facts[0]!.text.match(/Topic_\d/)![0];
      requestsByTopic.set(topic, [...(requestsByTopic.get(topic) ?? []), JSON.stringify({ messages: request.messages, schema: request.schema })]);
      return Object.fromEntries(facts.map(fact => [String(fact.id), topic === "Topic_0" ? 0 : fact.id]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants[0]!.said.filter(point => point.includes("Topic_0")).length).toBeLessThan(6);
    expect(new Set(result.participants[0]!.said.flatMap(point => point.split("\n"))))
      .toEqual(new Set(transcript.segments.map(segment => prefix(segment.text))));
    for (const topic of ["Topic_1", "Topic_2"]) {
      const calls = requestsByTopic.get(topic)!;
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls).size).toBe(calls.length);
    }
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("rejects missing candidate coverage rather than publishing a shortened partial Summary", async () => {
    const { model, requests } = adapter(facts => facts.slice(0, -1).map(fact => ({ ...fact, covers: [fact.id] })));
    await expect(createGroundedSummariser({ model, attempts: 2 })(uniqueCommitments())).rejects.toThrow("Missing candidate IDs");
    expect(requests.every(request => !((request.schema as { properties: object }).properties && "tldr" in (request.schema as { properties: object }).properties))).toBe(true);
  });

  it("repairs an omitted candidate only when retry feedback names its ID and original speaker", async () => {
    let repaired = 0;
    const { model, requests } = adapter((facts, _sources, request) => {
      const missing = facts.at(-1)!;
      const instruction = (JSON.parse(request.messages.at(-1)!.content) as { instruction: string }).instruction;
      const required = data(request).requiredCoverage!;
      expect(required[missing.speaker]).toContain(missing.id);
      if (instruction.includes(`Missing candidate IDs: ${missing.id}(${missing.speaker})`)) {
        repaired++;
        return facts.map(fact => ({ ...fact, covers: [fact.id] }));
      }
      return facts.slice(0, -1).map(fact => ({ ...fact, covers: [fact.id] }));
    });
    const result = await createGroundedSummariser({ model })(uniqueCommitments());
    expect(repaired).toBeGreaterThan(0);
    expect(result.participants[0]!.said).toHaveLength(9);
    expect(result.evidence!.participants[0]!.said).toEqual(Array.from({ length: 9 }, (_, ref) => [ref]));
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    for (const request of requests.filter(request => data(request).candidates && !("tldr" in (request.schema as { properties: object }).properties))) {
      const instruction = (JSON.parse(request.messages.at(-1)!.content) as { instruction: string }).instruction;
      if (instruction.includes("Missing candidate IDs:")) expect(instruction).not.toContain("I will complete Task_");
    }
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

  it("normalizes earlier-ID chains while retaining every immutable original clause and leaf bundle", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("Deploy branch Alpha.");
    transcript.segments[1]!.text = original("Deploy branch alpha.");
    let longest = 0;
    const { model, requests } = assignmentAdapter(facts => {
      longest = Math.max(longest, facts.length);
      // Even incorrect semantic grouping cannot erase a distinct claim or change its text.
      return Object.fromEntries(facts.map(fact => [String(fact.id), Math.max(0, fact.id - 1)]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    expect(longest).toBeGreaterThanOrEqual(3);
    expect(new Set(result.participants[0]!.said.flatMap(point => point.split("\n"))))
      .toEqual(new Set(transcript.segments.map(segment => prefix(segment.text))));
    expect(new Set(result.evidence!.participants[0]!.said.flat())).toEqual(new Set(transcript.segments.map((_, ref) => ref)));
    const final = data(requests.at(-1)!);
    // TLDR inputs are complete original leaf facts, never concatenated group prose.
    expect(final.candidates!.every(fact => transcript.segments.some(segment => prefix(segment.text) === fact.text))).toBe(true);
    expect(final.candidates!.every(fact => fact.sourceIds.length === 1)).toBe(true);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it.each(["missing", "extra", "string", "fraction", "negative", "forward"])("rejects %s assignments after three bounded attempts without publishing", async invalid => {
    let reductions = 0;
    const { model, requests } = assignmentAdapter(facts => {
      reductions++;
      const assignments: Record<string, unknown> = Object.fromEntries(facts.map(fact => [String(fact.id), fact.id]));
      if (invalid === "missing") delete assignments["0"];
      else if (invalid === "extra") assignments.unknown = 0;
      else assignments["0"] = { string: "0", fraction: 0.5, negative: -1, forward: 1 }[invalid];
      return assignments;
    });
    await expect(createGroundedSummariser({ model })(uniqueCommitments())).rejects.toThrow("failed validation after 3 attempts");
    expect(reductions).toBe(3);
    expect(requests.some(request => "tldr" in (request.schema as { properties: object }).properties)).toBe(false);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });
  it("does not reuse assignments for the same candidates when comparison context changes", async () => {
    const transcript: Transcript = { segments: Array.from({ length: 48 }, (_, index) => ({
      start: index, end: index + 1, speaker: index % 3 ? "Speaker 1" : "You",
      text: `Topic_${Math.floor(index / 12)} claim_${index}. | ` + "original supporting discussion ".repeat(6),
    })) };
    const contextsByCandidates = new Map<string, Set<string>>();
    const { model, requests } = assignmentAdapter((facts, request) => {
      const key = JSON.stringify(facts);
      const contexts = contextsByCandidates.get(key) ?? new Set<string>();
      contexts.add(JSON.stringify(data(request).sources));
      contextsByCandidates.set(key, contexts);
      return Object.fromEntries(facts.map(fact => [String(fact.id), fact.speaker === "Speaker 1" ? 0 : fact.id]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    // Other topic groups shrink between rounds. The same owned candidates must
    // still reach the model again when their original comparison context differs.
    expect([...contextsByCandidates.values()].some(contexts => contexts.size > 1)).toBe(true);
    expect(new Set(result.participants.flatMap(participant => participant.said.flatMap(point => point.split("\n")))))
      .toEqual(new Set(transcript.segments.map(segment => prefix(segment.text))));
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("merges exact repeated claims across references while keeping all evidence and compact TLDR originals", async () => {
    const transcript = uniqueCommitments();
    transcript.segments.forEach(segment => { segment.text = original("I will complete the offline check by Thursday."); });
    const { model, requests } = adapter();
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants[0]!.said).toEqual(["I will complete the offline check by Thursday."]);
    expect(result.evidence!.participants[0]!.said).toEqual([transcript.segments.map((_, ref) => ref)]);
    const final = data(requests.at(-1)!);
    expect(final.candidates).toHaveLength(1);
    expect(final.candidates![0]!.sourceIds).toEqual(["8:0"]);
    expect(final.sources).toHaveLength(1);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("seeds outcomes and uncertainty while prioritizing distinct commitments over repetitive review decisions", async () => {
    const transcript: Transcript = { segments: Array.from({ length: 20 }, (_, ref) => ({
      start: ref * 20, end: ref * 20 + 15, speaker: "You", text: `Original substantive source ${ref}: ` + "supporting passage ".repeat(5),
    })) };
    const inner = adapter();
    const requests: TextRequest[] = [];
    const model: TextModel = { async complete(request) {
      requests.push(request);
      const primary = data(request).primary;
      if (!primary) return inner.model.complete(request);
      return { text: JSON.stringify({ facts: primary.map(piece => ({ speaker: piece.speaker, sourceIds: [piece.id],
        kind: piece.ref === 19 ? "unresolved" : piece.ref === 17 || piece.ref === 18 ? "commitment" : "decision",
        text: piece.ref === 19 ? "Packaging has no owner." : piece.ref === 18 ? "Will retest offline on Thursday."
          : piece.ref === 17 ? "Will update the guide on Wednesday." : `Distinct earlier outcome ${piece.ref}.`,
      })) }), metadata: { model: "priority:test", elapsedMs: 1 } };
    } };
    await createGroundedSummariser({ model })(transcript);
    const final = data(requests.at(-1)!);
    expect(final.candidates!.slice(0, 4).map(fact => fact.text)).toEqual([
      "Distinct earlier outcome 16.", "Will retest offline on Thursday.", "Packaging has no owner.", "Will update the guide on Wednesday.",
    ]);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

});
