import { describe, expect, it } from "vitest";
import type { OriginalSentence } from "./sentence-claims.js";
import type { TextModel, TextRequest } from "./language-model.js";
import type { Transcript } from "./pipeline.js";
import { createGroundedSummariser } from "./grounded-summariser.js";
import { requestBytes } from "./model-request.js";

interface Piece { id: string; ref: number; part: number; speaker: string; text: string }
interface Candidate { id: number; speaker: string; text: string; sourceIds: string[]; kind: string }
interface Payload { primary?: OriginalSentence[]; candidates?: Candidate[]; sources?: Piece[] }
const input = (request: TextRequest): Payload => {
  const value = JSON.parse(request.messages[1]!.content) as Payload & { data?: Payload };
  return value.data ?? value;
};
const topic = (text: string): string => text.match(/Topic[A-C]/)?.[0] ?? "unknown";

/**
 * This adapter merges only repetitions of the same explicit local-processing requirement.
 * It preserves every distinct topic, unlike a reducer that drops all but its last candidate.
 */
function topicModel(nameFor: (text: string) => string = topic) {
  const requests: TextRequest[] = [];
  const reductions: { topics: string[]; refs: number[] }[] = [];
  const model: TextModel = { async complete(request) {
    requests.push(request);
    const payload = input(request);
    let output: unknown;
    if ("revisions" in (request.schema as { properties: object }).properties) { output = { revisions: Object.fromEntries(payload.candidates!.map(fact => [String(fact.id), "unchanged"])) }; }
    else if (payload.primary) {
      output = { classifications: Object.fromEntries(payload.primary.map(piece => [piece.id,
        piece.sourceId.endsWith(":0") && piece.id.endsWith(":0") ? "update" : "procedure",
      ])) };
    } else if (payload.candidates && !("candidateIds" in (request.schema as { properties: object }).properties)) {
      const facts = payload.candidates!;
      const original = new Map(payload.sources!.map(piece => [piece.id, piece]));
      reductions.push({ topics: facts.map(fact => nameFor(fact.text)),
        refs: facts.map(fact => Math.max(...fact.sourceIds.map(id => original.get(id)!.ref))) });
      const latest = new Map<string, { fact: Candidate; covers: number[] }>();
      for (const fact of facts) {
        // Every source in this fixture states the same requirement for its topic.
        // The latest repeated statement is sufficient evidence; other topics are never discarded.
        expect(fact.sourceIds.every(id => original.get(id)?.text.includes(nameFor(fact.text)))).toBe(true);
        const name = nameFor(fact.text);
        latest.set(name, { fact, covers: [...(latest.get(name)?.covers ?? []), fact.id] });
      }
      output = Object.fromEntries([...latest.values()].flatMap(({ covers }) => covers.map(id => [String(id), Math.min(...covers)])));
    } else {
      output = { candidateIds: payload.candidates!.slice(0, 3).map(fact => fact.id) };
    }
    return { text: JSON.stringify(output), metadata: { model: "faithful-topics:test", elapsedMs: 1 } };
  } };
  return { model, requests, reductions };
}

const interleavedTranscript = (): Transcript => ({ segments: Array.from({ length: 12 }, (_, index) => ({
  start: index * 30, end: index * 30 + 25, speaker: "You",
  text: `${["TopicA", "TopicB", "TopicC"][index % 3]} still requires fully local processing; review round ${Math.floor(index / 3) + 1}. `
    + "We are reviewing the same existing requirement, without assigning a new task. ".repeat(9),
})) });

describe("long Meeting topic consolidation", () => {
  it("compares distant repeated topics without discarding distinct requirements to force convergence", async () => {
    const { model, requests, reductions } = topicModel();
    const result = await createGroundedSummariser({ model })(interleavedTranscript());
    expect(result.participants).toHaveLength(1);
    expect(result.participants[0]!.said.length).toBeLessThan(12);
    expect(new Set(result.participants[0]!.said.map(topic))).toEqual(new Set(["TopicA", "TopicB", "TopicC"]));
    expect(reductions.some(group => new Set(group.topics).size < group.topics.length)).toBe(true);
    for (const group of reductions) expect(group.refs).toEqual([...group.refs].sort((a, b) => a - b));
    expect(requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    expect(result.generation!.calls).toBe(requests.length);
    expect(requests.length).toBeLessThan(30);
  });
  it("keeps case-sensitive identifiers distinct even when ranking puts them together", async () => {
    const branch = (text: string) => text.match(/Branch (?:Alpha|alpha|Beta)/)?.[0] ?? "unknown";
    const { model, reductions } = topicModel(branch);
    const original = interleavedTranscript();
    const names = ["Branch Alpha", "Branch alpha", "Branch Beta"];
    original.segments.forEach((segment, index) => { segment.text = segment.text.replace(/Topic[A-C]/, names[index % 3]!); });
    const result = await createGroundedSummariser({ model })(original);
    expect(result.participants[0]!.said.length).toBeLessThan(12);
    expect(new Set(result.participants[0]!.said.map(branch))).toEqual(new Set(names));
    expect(reductions.some(group => group.topics.includes("Branch Alpha") && group.topics.includes("Branch alpha"))).toBe(true);
  });
});
