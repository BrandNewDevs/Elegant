import { describe, expect, it } from "vitest";
import type { TextModel, TextRequest } from "./language-model.js";
import type { Transcript } from "./pipeline.js";
import { createGroundedSummariser, SUMMARY_PROMPT_VERSION } from "./grounded-summariser.js";
import { requestBytes } from "./model-request.js";
import { transcriptRevision } from "./evidence.js";

const transcript: Transcript = { segments: [
  { start: 0, end: 5, speaker: "You", text: "I will write the permission guide by Thursday." },
  { start: 5, end: 10, speaker: "Speaker 1", text: "Friday is a proposal only. No launch date is agreed." },
] };
const good = { tldr: "The permission guide is due Thursday; the launch date is unresolved.", tldrRefs: [0, 1], points: [
  { speaker: "You", text: "Will write the permission guide by Thursday.", refs: [0] },
  { speaker: "Speaker 1", text: "Friday was proposed but no launch date was agreed.", refs: [1] },
] };
function fake(reply: (request: TextRequest, call: number) => unknown): TextModel & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return { requests, async complete(request) {
    requests.push(request);
    const value = reply(request, requests.length);
    return { text: typeof value === "string" ? value : JSON.stringify(value),
      metadata: { model: "local:test", elapsedMs: 1, promptTokens: 30, outputTokens: 20 } };
  } };
}
interface Piece { id: string; ref: number; part: number; speaker: string; text: string }
interface Fact { speaker: string; text: string; refs: number[]; sourceIds: string[]; kind: string }
interface Payload { sources?: Piece[]; primary?: Piece[]; context?: Piece[]; candidates?: Fact[] }
const payload = (request: TextRequest): Payload => JSON.parse(request.messages[1]!.content) as Payload;

/** A deterministic adapter exercises orchestration, budgets and provenance, not factual model quality. */
function hierarchicalReply(request: TextRequest): unknown {
  const input = payload(request);
  if (input.primary) return { facts: input.primary.map(source => ({ speaker: source.speaker, text: `Important point from ${source.id}.`,
    refs: [source.ref], sourceIds: [source.id], kind: "update" })) };
  if ("facts" in (request.schema as { properties: object }).properties) return { facts: [input.candidates!.at(-1)] };
  const source = input.sources!.at(-1)!;
  return { tldr: "The final supported point is retained.", tldrRefs: [source.ref],
    points: [{ speaker: source.speaker, text: "The final supported point.", refs: [source.ref] }] };
}
const longTranscript = (): Transcript => ({ segments: Array.from({ length: 36 }, (_, index) => ({ start: index * 40, end: index * 40 + 35,
  speaker: index % 2 ? "Speaker 1" : "You", text: (`Discussion of item ${index}: local permissions and the pending launch decision. `).repeat(15) })) });

describe("evidence-backed Summary generation", () => {
  it("returns compatible points, parallel references, revision and generation measurements", async () => {
    const model = fake(() => good);
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result).toEqual({ tldr: good.tldr, participants: good.points.map(point => ({ speaker: point.speaker, said: [point.text] })),
      evidence: { revision: transcriptRevision(transcript), tldr: [0, 1], participants: [
        { speaker: "You", said: [[0]] }, { speaker: "Speaker 1", said: [[1]] },
      ] }, generation: { promptVersion: SUMMARY_PROMPT_VERSION, model: "local:test", calls: 1, elapsedMs: expect.any(Number), promptTokens: 30, outputTokens: 20 } });
    expect(model.requests[0]!.messages[0]!.role).toBe("system");
    expect(model.requests[0]!.messages[0]!.content).not.toContain(transcript.segments[0]!.text);
    expect(model.requests[0]!.messages[1]!.content).toContain(transcript.segments[0]!.text);
    expect(requestBytes(model.requests[0]!)).toBeLessThanOrEqual(5500);
  });

  it("groups multiple points by exact speaker labels without duplicate Participant entries", async () => {
    const model = fake(() => ({ ...good, points: [...good.points, { speaker: "You", text: "No launch date is agreed.", refs: [0, 1] }] }));
    const result = await createGroundedSummariser({ model })(transcript);
    expect(result.participants).toHaveLength(2);
    expect(result.participants[0]!.said).toHaveLength(2);
    expect(result.evidence!.participants[0]!.said).toEqual([[0], [0, 1]]);
  });

  it("retries invalid JSON or attribution at most three total attempts", async () => {
    const model = fake((_request, call) => call === 1 ? "not JSON" : call === 2 ? { ...good, points: [{ speaker: "Invented", text: "A claim", refs: [0] }] } : good);
    const result = await createGroundedSummariser({ model, attempts: 9 })(transcript);
    expect(result.generation!.calls).toBe(3);
    expect(model.requests).toHaveLength(3);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    expect(model.requests[1]!.messages[0]!.content).toContain("previous output failed validation");
  });

  it("reports the last static rejection reason and reserves its retry budget", async () => {
    const model = fake(() => ({ ...good, points: [{ speaker: "Invented", text: "Private generated prose", refs: [0] }] }));
    await expect(createGroundedSummariser({ model })(transcript)).rejects.toThrow("Attribute each point to a supplied speaker");
    expect(model.requests).toHaveLength(3);
    expect(model.requests[1]!.messages[0]!.content).toContain("Attribute each point to a supplied speaker");
    expect(model.requests[1]!.messages[0]!.content).not.toContain("Private generated prose");
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("rejects unknown references, blank points and evidence from a different speaker", async () => {
    const invalid = [
      { ...good, tldrRefs: [99] },
      { ...good, tldrRefs: [0, 0] },
      { ...good, points: [{ speaker: "You", text: " ", refs: [0] }] },
      { ...good, points: [{ speaker: "You", text: "A claim", refs: [1] }] },
    ];
    for (const reply of invalid) {
      const model = fake(() => reply);
      await expect(createGroundedSummariser({ model, attempts: 1 })(transcript)).rejects.toThrow("failed validation");
      expect(model.requests).toHaveLength(1);
    }
  });

  it("does not retry connection errors and never returns an empty Transcript Summary", async () => {
    const model = fake(() => { throw new Error("Start Ollama and retry"); });
    await expect(createGroundedSummariser({ model })(transcript)).rejects.toThrow("Start Ollama");
    expect(model.requests).toHaveLength(1);
    await expect(createGroundedSummariser({ model })({ segments: [] })).rejects.toThrow("Transcript is empty");
  });

  it("carries original passages through multiple reduction levels within every request budget", async () => {
    const source = longTranscript();
    const model = fake(hierarchicalReply);
    const result = await createGroundedSummariser({ model })(source);
    const reductions = model.requests.filter(request => payload(request).candidates && "facts" in (request.schema as { properties: object }).properties);
    expect(reductions.length).toBeGreaterThan(2);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    for (const request of reductions) {
      const input = payload(request);
      expect(input.sources!.length).toBeGreaterThan(0);
      for (const piece of input.sources!) expect(source.segments[piece.ref]!.text).toContain(piece.text);
      expect(input.candidates!.every(fact => fact.sourceIds.every(id => input.sources!.some(piece => piece.id === id)))).toBe(true);
    }
    expect(result.evidence!.revision).toBe(transcriptRevision(source));
    expect(result.evidence!.tldr).toEqual([35]);
    expect(result.generation!.calls).toBe(model.requests.length);
  });

  it("preserves long single-segment text and ordinal references without pulling all fragments into each fact", async () => {
    const source: Transcript = { segments: [{ start: 0, end: 3600, speaker: "You", text: "Local Unicode café 😀 discussion. ".repeat(1500) }] };
    const model = fake(hierarchicalReply);
    const result = await createGroundedSummariser({ model })(source);
    const primary = model.requests.flatMap(request => payload(request).primary ?? []);
    expect(primary.map(piece => piece.text).join("")).toBe(source.segments[0]!.text);
    expect(new Set(primary.map(piece => piece.id)).size).toBe(primary.length);
    expect(result.evidence!.tldr).toEqual([0]);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("handles a single oversized word without losing Unicode characters", async () => {
    const text = "😀".repeat(5000);
    const model = fake(hierarchicalReply);
    await createGroundedSummariser({ model })({ segments: [{ start: 0, end: 1, speaker: "You", text }] });
    const pieces = model.requests.flatMap(request => payload(request).primary ?? []);
    expect(pieces.map(piece => piece.text).join("")).toBe(text);
  });

  it("uses prior context only as supporting context and validates extraction source IDs", async () => {
    const source = longTranscript();
    const model = fake(request => {
      const input = payload(request);
      if (input.primary) return { facts: [{ speaker: input.primary[0]!.speaker, text: "A claim", refs: [input.primary[0]!.ref], sourceIds: ["missing:0"], kind: "decision" }] };
      return hierarchicalReply(request);
    });
    await expect(createGroundedSummariser({ model, attempts: 1 })(source)).rejects.toThrow("failed validation");
  });

  it("fails clearly when reductions do not converge instead of concatenating chunk results", async () => {
    const model = fake(request => {
      const input = payload(request);
      if (input.candidates) return { facts: input.candidates };
      return hierarchicalReply(request);
    });
    await expect(createGroundedSummariser({ model })(longTranscript())).rejects.toThrow("did not reduce");
    expect(model.requests.length).toBeLessThan(128);
  });

  it("enforces the global model-call limit across extraction, consolidation and retries", async () => {
    const model = fake(hierarchicalReply);
    await expect(createGroundedSummariser({ model, maxCalls: 2 })(longTranscript())).rejects.toThrow("model-call limit");
    expect(model.requests).toHaveLength(2);
  });

  it("passes cancellation to the model and rejects late output after cancellation", async () => {
    const controller = new AbortController();
    const model = fake(request => { expect(request.signal).toBeDefined(); controller.abort(); return good; });
    await expect(createGroundedSummariser({ model })(transcript, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(model.requests).toHaveLength(1);
  });

  it("stops a result arriving after the generation deadline", async () => {
    const model: TextModel = { async complete() { await new Promise(resolve => setTimeout(resolve, 15)); return { text: JSON.stringify(good), metadata: { model: "local:test", elapsedMs: 15 } }; } };
    await expect(createGroundedSummariser({ model, deadlineMs: 5 })(transcript)).rejects.toThrow("deadline");
  });
});
