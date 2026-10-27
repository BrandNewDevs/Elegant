import { describe, expect, it } from "vitest";
import { SENTENCE_KINDS, type OriginalSentence } from "./sentence-claims.js";
import { createGroundedSummariser, SUMMARY_PROMPT_VERSION } from "./grounded-summariser.js";
import { requestBytes } from "./model-request.js";
import type { Transcript } from "./pipeline.js";
import type { TextModel, TextRequest } from "./language-model.js";

const kindCode = (kind: string) => SENTENCE_KINDS.findIndex(candidate => candidate === kind);
type WireSentence = Omit<OriginalSentence, "sourceId">;
const sourceId = (sentence: WireSentence) => sentence.id.slice(0, sentence.id.lastIndexOf(":"));
interface Piece { id: string; ref: number; part: number; speaker: string; text: string }
interface Fact { id: number; speaker: string; text: string; kind: string; sourceIds: string[]; covers?: number[] }
interface Payload { requiredCoverage?: Record<string, number[]>; primary?: WireSentence[]; sources?: Piece[]; candidates?: Fact[]; totalFacts?: number; otherFactsRetained?: number }
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
    if ("revisions" in (request.schema as { properties: object }).properties) output = { revisions: Object.fromEntries(input.candidates!.map(fact => [String(fact.id), "unchanged"])) };
    else if (input.primary) output = { classifications: input.primary.map(piece =>
      kindCode(sourceId(piece).endsWith(":0") && piece.id.endsWith(":0")
        ? /propose|suggest/i.test(piece.text) ? "proposal" : /final decision/i.test(piece.text) ? "decision" : "commitment" : "procedure")) };
    else if (input.candidates && !("candidateIds" in (request.schema as { properties: object }).properties)) output = Object.fromEntries(reduce(input.candidates, input.sources!, request).flatMap(fact => (fact.covers ?? []).map(id => [String(id), Math.min(...fact.covers!)])));
    else output = { candidateIds: input.candidates!.slice(0, 3).map(fact => fact.id) };
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
    if (input.candidates && !("revisions" in (request.schema as { properties: object }).properties) && !("candidateIds" in (request.schema as { properties: object }).properties)) {
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
    expect(requests.filter(request => !("candidateIds" in (request.schema as { properties: object }).properties) && data(request).candidates).length).toBeGreaterThan(1);
  });

  it("omits a bare numbered topic heading while retaining the facts in its segment", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = `Review round 1, topic permissions. ${original("I will complete the permission setup by Friday.")}`;
    const inner = adapter();
    let classified: string[] = [];
    const model: TextModel = { async complete(request) {
      const input = data(request);
      if (!input.primary) return inner.model.complete(request);
      classified.push(...input.primary.map(sentence => sentence.text));
      return { text: JSON.stringify({ classifications: input.primary.map(sentence =>
        sentence.text.includes("permission setup") ? kindCode("commitment") : kindCode("update")) }),
        metadata: { model: "agenda:test", elapsedMs: 1 } };
    } };
    const result = await createGroundedSummariser({ model })(transcript);
    expect(classified).not.toContain("Review round 1, topic permissions.");
    expect(result.participants.flatMap(participant => participant.said)).not.toContain("Review round 1, topic permissions.");
    expect(result.participants.find(participant => participant.speaker === "You")!.said)
      .toContain("I will complete the permission setup by Friday.");
  });

  it("deduplicates an exact same-speaker sentence despite differing model kind labels", async () => {
    const repeated = "The permission flow has separate microphone and system-audio steps.";
    const transcript: Transcript = { segments: Array.from({ length: 9 }, (_, index) => ({
      start: index * 30, end: index * 30 + 20, speaker: "You", text: original(index < 2 ? repeated : `I will complete Task_${index} by day ${index + 1}.`),
    })) };
    const { model } = assignmentAdapter((facts, request) => Object.fromEntries(facts.map(fact => [String(fact.id), fact.id])));
    const fake = model as TextModel;
    const wrapped: TextModel = { async complete(request) {
      const input = data(request);
      if (input.primary) return { text: JSON.stringify({ classifications: input.primary.map(sentence =>
        sentence.text === repeated ? (sentence.id.startsWith("0:") ? kindCode("proposal") : kindCode("commitment")) : kindCode("update")) }),
        metadata: { model: "repeat-kind:test", elapsedMs: 1 } };
      return fake.complete(request);
    } };
    const result = await createGroundedSummariser({ model: wrapped })(transcript);
    const owner = result.participants.find(participant => participant.speaker === "You")!;
    expect(owner.said.filter(point => point === repeated)).toHaveLength(1);
    expect(result.evidence!.participants.find(participant => participant.speaker === "You")!.said[owner.said.indexOf(repeated)])
      .toEqual([0, 1]);
  });

  it("selects whole immutable long-Meeting claims and derives their sources instead of accepting TLDR prose", async () => {
    const transcript = uniqueCommitments();
    const inner = adapter();
    let selected: Fact[] = [];
    const model: TextModel = { async complete(request) {
      if (!("candidateIds" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      const input = data(request);
      selected = input.candidates!.slice(0, 2);
      return { text: JSON.stringify({ candidateIds: selected.map(fact => fact.id),
        tldr: "Invented deadline and owner.", sourceIds: ["missing:0"],
      }), metadata: { model: "selection:test", elapsedMs: 1 } };
    } };
    const result = await createGroundedSummariser({ model })(transcript);
    expect(selected).toHaveLength(2);
    expect(result.tldr).toBe(selected.map(fact => `${fact.speaker}: ${fact.text}`).join(" "));
    expect(result.tldr).not.toContain("Invented");
    const refs = selected.flatMap(fact => fact.sourceIds.map(id => Number(id.split(":")[0])));
    expect(result.evidence!.tldr).toEqual([...new Set(refs)].sort((a, b) => a - b));
  });

  it("rejects unknown final claim IDs after three attempts instead of publishing unauthored fallback prose", async () => {
    const inner = adapter();
    let attempts = 0;
    const model: TextModel = { async complete(request) {
      if (!("candidateIds" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      attempts++;
      return { text: JSON.stringify({ candidateIds: [999] }), metadata: { model: "selection:test", elapsedMs: 1 } };
    } };
    await expect(createGroundedSummariser({ model })(uniqueCommitments())).rejects.toThrow("Select supplied point IDs");
    expect(attempts).toBe(3);
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
    expect(requests.filter(request => data(request).candidates && !("revisions" in (request.schema as { properties: object }).properties) && !("candidateIds" in (request.schema as { properties: object }).properties))).toHaveLength(0);
    for (const speaker of speakers) {
      expect(result.participants.find(participant => participant.speaker === speaker)!.said)
        .toEqual(transcript.segments.filter(segment => segment.speaker === speaker).map(segment => prefix(segment.text)));
    }
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("consolidates equivalent whole-claim paraphrases while retaining every original source", async () => {
    const transcript = uniqueCommitments();
    const earlier = "I will test the permission flow by Thursday.";
    const latest = "By Thursday, I will test the permission flow.";
    transcript.segments[0]!.text = original(earlier);
    transcript.segments[1]!.text = original(latest);
    const { model, requests } = assignmentAdapter(facts => {
      const duplicates = facts.filter(fact => fact.sourceIds.some(id => id === "0:0" || id === "1:0"));
      const seed = duplicates[0]?.id;
      return Object.fromEntries(facts.map(fact => [String(fact.id), duplicates.includes(fact) ? seed! : fact.id]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    const owner = result.participants[0]!;
    expect(owner.said).toContain(latest);
    expect(owner.said.some(point => point.includes(earlier))).toBe(false);
    expect(owner.said).toHaveLength(8);
    expect(result.evidence!.participants[0]!.said[owner.said.indexOf(latest)]).toEqual([0, 1]);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("condenses an equivalent subset within a topic while retaining a distinct task and all source evidence", async () => {
    const transcript = uniqueCommitments();
    const earlier = "I will test the permission flow by Thursday.";
    const latest = "By Thursday, I will test the permission flow.";
    const distinct = "I will review the permission guide on Friday.";
    transcript.segments[0]!.text = original(earlier);
    transcript.segments[1]!.text = original(latest);
    transcript.segments[2]!.text = original(distinct);
    const { model, requests } = assignmentAdapter(facts => {
      const related = facts.filter(fact => fact.sourceIds.some(id => ["0:0", "1:0", "2:0"].includes(id)));
      return Object.fromEntries(facts.map(fact => [String(fact.id), related.includes(fact) ? related[0]!.id : fact.id]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    const point = `${latest}\n${distinct}`;
    const owner = result.participants[0]!;
    expect(owner.said).toContain(point);
    expect(owner.said.some(text => text.includes(earlier))).toBe(false);
    expect(owner.said).toHaveLength(7);
    expect(result.evidence!.participants[0]!.said[owner.said.indexOf(point)]).toEqual([0, 1, 2]);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it.each([
    ["deadline", "I will test the permission flow by Thursday.", "By Friday, I will test permission flow."],
    ["owner", "I will test the permission flow by Thursday.", "By Thursday, Speaker 1 will test permission flow."],
    ["action", "I will test the permission flow by Thursday.", "By Thursday, I will review permission flow."],
    ["case-sensitive identifier", "I will deploy Branch Alpha by Thursday.", "By Thursday, I will deploy Branch alpha."],
    ["identifier punctuation", "I will deploy API-1 by Thursday.", "By Thursday, I will deploy API 1."],
    ["number", "I will run 3 permission tests by Thursday.", "By Thursday, I will run 4 permission tests."],
    ["single-letter identifier", "I will test branch A.", "I will test branch."],
    ["lowercase identifier", "I will test branch a.", "I will test branch."],
    ["currency", "Budget is $500.", "Budget is €500."],
    ["comparison operator", "Latency must be < 60 ms.", "Latency must be > 60 ms."],
    ["signed value", "The balance is -500.", "The balance is +500."],
    ["quoted title deadline", 'By Monday I will review "Friday Plan".', 'I will review "Friday Plan by Monday".'],
    ["negation", "I will test the permission flow by Thursday.", "By Thursday, I will not test permission flow."],
    ["modality", "I will test the permission flow by Thursday.", "By Thursday, I might test permission flow."],
    ["question", "I will test the permission flow by Thursday.", "By Thursday, I will test permission flow?"],
    ["quotation", "I will test the permission flow by Thursday.", 'By Thursday, "I will test permission flow."'],
  ])("retains both clauses when a model groups claims with a changed %s", async (_detail, earlier, latest) => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original(earlier);
    transcript.segments[1]!.text = original(latest);
    const { model } = assignmentAdapter(facts => {
      const targets = facts.filter(fact => fact.sourceIds.some(id => id === "0:0" || id === "1:0"));
      return Object.fromEntries(facts.map(fact => [String(fact.id), targets.includes(fact) ? targets[0]!.id : fact.id]));
    });
    const result = await createGroundedSummariser({ model })(transcript);
    const clauses = result.participants[0]!.said.flatMap(point => point.split("\n"));
    expect(clauses).toContain(earlier);
    expect(clauses).toContain(latest);
    const refs = result.evidence!.participants[0]!.said.flat();
    expect(refs).toContain(0);
    expect(refs).toContain(1);
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
    expect(requests.every(request => !((request.schema as { properties: object }).properties && "candidateIds" in (request.schema as { properties: object }).properties))).toBe(true);
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
    for (const request of requests.filter(request => data(request).candidates && !("revisions" in (request.schema as { properties: object }).properties) && !("candidateIds" in (request.schema as { properties: object }).properties))) {
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
    expect(inner.requests.every(request => !("candidateIds" in (request.schema as { properties: object }).properties))).toBe(true);
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
    expect(requests.some(request => "candidateIds" in (request.schema as { properties: object }).properties)).toBe(false);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });
  it("does not reuse assignments for the same candidates when comparison context changes", async () => {
    const transcript: Transcript = { segments: Array.from({ length: 48 }, (_, index) => ({
      start: index, end: index + 1, speaker: index % 3 ? "Speaker 1" : "You",
      text: `Topic_${Math.floor(index / 12)} claim_${index}. | ` + "Original supporting discussion. ".repeat(6),
    })) };
    const contextsByCandidates = new Map<string, Set<string>>();
    const { model, requests } = assignmentAdapter((facts, request) => {
      const key = JSON.stringify(facts);
      const contexts = contextsByCandidates.get(key) ?? new Set<string>();
      contexts.add(JSON.stringify(data(request).sources));
      contextsByCandidates.set(key, contexts);
      return Object.fromEntries(facts.map(fact => [String(fact.id), fact.speaker === "Speaker 1" ? 0 : fact.id]));
    });
    const summarise = createGroundedSummariser({ model });
    const result = await summarise(transcript);
    const changedContext = structuredClone(transcript);
    for (const segment of changedContext.segments) {
      if (segment.speaker === "Speaker 1") segment.text = segment.text.replaceAll("Original supporting discussion.", "Altered supporting discussion.");
    }
    await summarise(changedContext);
    // Keep candidate claims and byte lengths fixed while changing foreign
    // original context. No previous assignment may bypass that new comparison.
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
      start: ref * 20, end: ref * 20 + 15, speaker: "You", text: (ref === 19 ? "Packaging has no owner." : ref === 18 ? "Will retest offline on Thursday."
        : ref === 17 ? "Will update the guide on Wednesday." : `Distinct earlier outcome ${ref}.`) + " Supporting passage. ".repeat(5),
    })) };
    const inner = adapter();
    const requests: TextRequest[] = [];
    const model: TextModel = { async complete(request) {
      requests.push(request);
      const primary = data(request).primary;
      if (!primary) return inner.model.complete(request);
      return { text: JSON.stringify({ classifications: primary.map(piece =>
        kindCode(!sourceId(piece).endsWith(":0") || !piece.id.endsWith(":0") ? "procedure" : Number(sourceId(piece).split(":")[0]) === 19 ? "unresolved"
          : [17, 18].includes(Number(sourceId(piece).split(":")[0])) ? "commitment" : "decision")) }), metadata: { model: "priority:test", elapsedMs: 1 } };
    } };
    await createGroundedSummariser({ model })(transcript);
    const final = data(requests.at(-1)!);
    expect(final.candidates!.slice(0, 4).map(fact => fact.text)).toEqual([
      "Distinct earlier outcome 16.", "Will retest offline on Thursday.", "Packaging has no owner.", "Will update the guide on Wednesday.",
    ]);
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it.each(["You", "Speaker 1"])("marks an earlier proposal superseded by %s without transferring its ownership", async corrector => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.speaker = corrector;
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    const inner = adapter();
    let assessed = false;
    const requests: TextRequest[] = [];
    const model: TextModel = { async complete(request) {
      requests.push(request);
      if (!("revisions" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      const input = data(request);
      const proposal = input.candidates!.find(fact => fact.text.includes("propose launching"));
      const correction = input.sources!.find(source => source.ref === 8);
      const revisions = Object.fromEntries(input.candidates!.map(fact => [String(fact.id), proposal && correction && fact.id === proposal.id ? correction.id : "unchanged"]));
      assessed ||= !!proposal && !!correction;
      return { text: JSON.stringify({ revisions }), metadata: { model: "disposition:test", elapsedMs: 1 } };
    } };
    const result = await createGroundedSummariser({ model })(transcript);
    expect(assessed).toBe(true);
    const owner = result.participants.find(participant => participant.speaker === "You")!;
    const point = "Earlier proposal: I propose launching on Monday.";
    expect(owner.said).toContain(point);
    expect(result.evidence!.participants.find(participant => participant.speaker === "You")!.said[owner.said.indexOf(point)]).toEqual([0, 8]);
    expect(result.participants.find(participant => participant.speaker === corrector)!.said)
      .toContain("Final decision: launch Friday instead of Monday.");
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("does not schedule a superseding annotation for an unrelated later task", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.text = original("Final decision: review the Monday launch checklist spelling on Friday.");
    const { model, requests } = adapter();
    const result = await createGroundedSummariser({ model })(transcript);
    expect(requests.some(request => "revisions" in (request.schema as { properties: object }).properties)).toBe(false);
    expect(result.participants[0]!.said).toContain("I propose launching on Monday.");
    expect(result.participants[0]!.said.some(point => point.startsWith("Earlier"))).toBe(false);
  });

  it("does not treat a later release decision in the same Transcript segment as a corrected test result", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("The final offline review failed for the PDF path.");
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday. Markdown replaces PDF as the export format.");
    const { model, requests } = adapter();
    const result = await createGroundedSummariser({ model })(transcript);
    const owner = result.participants.find(participant => participant.speaker === "You")!;
    const outcome = owner.said.find(point => point.includes("The final offline review failed for the PDF path."))!;
    expect(outcome).toContain("The final offline review failed for the PDF path.");
    expect(outcome).not.toContain("Earlier");
    expect(requests.some(request => "revisions" in (request.schema as { properties: object }).properties)).toBe(false);
    expect(result.evidence!.participants.find(participant => participant.speaker === "You")!.said[owner.said.indexOf(outcome)]).toEqual([0]);
  });

  it("requires every eligible candidate and constrains its correction choices to later explicit original revisions", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    const { model, requests } = adapter();
    await createGroundedSummariser({ model })(transcript);
    const comparisons = requests.filter(request => "revisions" in (request.schema as { properties: object }).properties);
    expect(comparisons.length).toBeGreaterThan(0);
    for (const request of comparisons) {
      const input = data(request);
      const schema = request.schema as { properties: { revisions: { properties: Record<string, { enum: string[] }>; required: string[] } } };
      const revisions = schema.properties.revisions;
      expect(revisions.required).toEqual(input.candidates!.map(fact => String(fact.id)));
      for (const [id, choice] of Object.entries(revisions.properties)) {
        const fact = input.candidates![Number(id)]!;
        const own = input.sources!.filter(source => fact.sourceIds.includes(source.id) && source.speaker === fact.speaker)
          .sort((left, right) => left.ref - right.ref || left.part - right.part).at(-1)!;
        expect(choice.enum[0]).toBe("unchanged");
        expect(choice.enum.slice(1)).toEqual(["8:0"]);
        expect(choice.enum).not.toContain(own.id);
        expect(choice.enum).not.toContain("historical");
        expect(choice.enum).not.toContain("unresolved");
      }
      expect(requestBytes(request)).toBeLessThanOrEqual(5500);
    }
  });

  it.each(["unknown-source", "not-later", "unknown-candidate", "missing-candidate", "invented-status"])("rejects %s revision output after bounded retries", async invalid => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    const inner = adapter();
    let attempts = 0;
    const model: TextModel = { async complete(request) {
      if (!("revisions" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      attempts++;
      const input = data(request), fact = input.candidates![0]!;
      const revisions = Object.fromEntries(input.candidates!.map(candidate => [String(candidate.id), "unchanged"]));
      revisions[String(fact.id)] = invalid === "unknown-source" ? "missing:0" : invalid === "invented-status" ? "unresolved" : fact.sourceIds[0]!;
      if (invalid === "unknown-candidate") revisions["999"] = "unchanged";
      if (invalid === "missing-candidate") delete revisions[String(fact.id)];
      return { text: JSON.stringify({ revisions }), metadata: { model: "disposition:test", elapsedMs: 1 } };
    } };
    await expect(createGroundedSummariser({ model })(transcript)).rejects.toThrow("failed validation after 3 attempts");
    expect(attempts).toBe(3);
  });

  it("assesses both Participants' earlier proposals against the same final replacement", async () => {
    const transcript = uniqueCommitments();
    transcript.segments[0]!.text = original("I propose launching on Monday.");
    transcript.segments[1]!.speaker = "Speaker 1";
    transcript.segments[1]!.text = original("I propose Monday as the launch day.");
    transcript.segments[8]!.speaker = "Speaker 2";
    transcript.segments[8]!.text = original("Final decision: launch Friday instead of Monday.");
    const inner = adapter();
    const model: TextModel = { async complete(request) {
      if (!("revisions" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      const input = data(request);
      return { text: JSON.stringify({ revisions: Object.fromEntries(input.candidates!.map(fact => [String(fact.id), "8:0"])) }),
        metadata: { model: "revisions:test", elapsedMs: 1 } };
    } };
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants.find(participant => participant.speaker === "You")!.said).toContain("Earlier proposal: I propose launching on Monday.");
    expect(result.participants.find(participant => participant.speaker === "Speaker 1")!.said).toEqual(["Earlier proposal: I propose Monday as the launch day."]);
    expect(result.evidence!.participants.find(participant => participant.speaker === "Speaker 1")!.said).toEqual([[1, 8]]);
  });

  it("never requests a new uncertainty annotation for unchanged requirement reviews", async () => {
    const transcript = uniqueCommitments();
    transcript.segments.forEach(segment => { segment.text = original("Review the existing permission requirement. We are not adding an assignment or a deadline."); });
    const { model, requests } = adapter();
    const result = await createGroundedSummariser({ model })(transcript);
    expect(requests.some(request => "revisions" in (request.schema as { properties: object }).properties)).toBe(false);
    expect(result.participants[0]!.said.every(point => !point.startsWith("Earlier"))).toBe(true);
  });

  it("accepts correction evidence in a later fragment of the same original segment", async () => {
    const transcript: Transcript = { segments: [{ start: 0, end: 60, speaker: "You", text: "Monday launch proposal. " + "Background discussion. ".repeat(50) + "Friday launch replaces Monday. " + "Later discussion. ".repeat(400) }] };
    const inner = adapter();
    let sameOrdinalCorrection = false;
    const model: TextModel = { async complete(request) {
      const input = data(request);
      if (input.primary) return { text: JSON.stringify({ classifications: input.primary.map(piece =>
        kindCode(piece.text === "Monday launch proposal." ? "proposal" : "update")) }), metadata: { model: "fragment:test", elapsedMs: 1 } };
      if (!("revisions" in (request.schema as { properties: object }).properties)) return inner.model.complete(request);
      const proposal = input.candidates!.find(fact => fact.text === "Monday launch proposal.");
      const correction = input.sources!.find(source => source.part > 0 && source.text.includes("replaces Monday"));
      const revisions = Object.fromEntries(input.candidates!.map(fact => [String(fact.id), proposal && correction && fact.id === proposal.id ? correction.id : "unchanged"]));
      sameOrdinalCorrection ||= !!proposal && !!correction;
      return { text: JSON.stringify({ revisions }), metadata: { model: "fragment:test", elapsedMs: 1 } };
    } };
    const result = await createGroundedSummariser({ model })(transcript);
    expect(sameOrdinalCorrection).toBe(true);
    expect(result.participants[0]!.said).toContain("Earlier proposal: Monday launch proposal.");
    expect(result.evidence!.participants[0]!.said[0]).toEqual([0]);
  });

});
