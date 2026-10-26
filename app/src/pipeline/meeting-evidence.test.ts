import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/store.js";
import type { Transcript } from "./pipeline.js";
import type { EvidencePassage } from "./passages.js";
import type { TextModel, TextRequest } from "./language-model.js";
import { createMeetingEvidence } from "./meeting-evidence.js";
import { requestBytes } from "./model-request.js";
import { transcriptRevision, type SourceFragment } from "./evidence.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
function meeting(transcript: Transcript) {
  const store = openStore(":memory:");
  stores.push(store);
  const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27T00:00:00Z" });
  store.saveTranscript(id, transcript);
  store.setMeetingState(id, "done");
  return { store, id, passages: store.listPassages(id, transcriptRevision(transcript)) };
}
const short: Transcript = { segments: [{ start: 0, end: 5, speaker: "You", text: "Friday is only a proposal." }] };
const long = (): Transcript => ({ segments: Array.from({ length: 8 }, (_, index) => ({ start: index * 30, end: index * 30 + 25,
  speaker: index % 2 ? "Speaker 1" : "You", text: `Topic ${index} launch permissions. ` + "The local app must retain the original words and source references. ".repeat(12) })) });
interface Data { question: string; history: { question: string; answer: string }[]; sources?: SourceFragment[] }
const data = (request: TextRequest) => (JSON.parse(request.messages.at(-1)!.content) as { data: Data }).data;
const instruction = (request: TextRequest) => (JSON.parse(request.messages.at(-1)!.content) as { instruction: string }).instruction;
function model(reply: (request: TextRequest, call: number) => unknown): TextModel & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return { requests, async complete(request) {
    requests.push(request);
    const output = reply(request, requests.length);
    return { text: typeof output === "string" ? output : JSON.stringify(output), metadata: { model: "local:test", elapsedMs: 1 } };
  } };
}
const byCount = (max: number) => (sources: SourceFragment[]) => sources.length <= max;
function selection(request: TextRequest) {
  if (instruction(request).startsWith("Rewrite")) return { query: "launch permissions" };
  const sources = data(request).sources!;
  return { sourceIds: instruction(request).startsWith("Consolidate") ? sources.map(source => source.id) : [sources.at(-1)!.id], sufficient: true };
}
function fixedHits(store: Store, passages: EvidencePassage[]) {
  return { getMeeting: store.getMeeting, listPassages: store.listPassages, searchPassages: () => passages };
}

describe("Meeting-specific evidence retrieval", () => {
  it("returns the complete original Transcript without a model call when the answer budget fits", async () => {
    const { store, id } = meeting(short);
    const local = model(() => { throw new Error("No model should be called"); });
    const result = await createMeetingEvidence({ store, model: local })({ meetingId: id, question: "When is launch?" });
    expect(result).toMatchObject({ revision: transcriptRevision(short), mode: "full", exhaustive: true, sufficient: true, calls: 0 });
    expect(result.sources.map(source => source.text).join("")).toBe(short.segments[0]!.text);
    expect(local.requests).toHaveLength(0);
  });

  it("includes FTS hits, neighbors and a later correction even before the last passage", async () => {
    const source = long();
    source.segments[0]!.text = "Launch Friday. " + source.segments[0]!.text;
    source.segments[5]!.text = "Actually Monday instead. " + source.segments[5]!.text;
    const { store, id, passages } = meeting(source);
    const queries: string[] = [];
    const scopedStore = { ...fixedHits(store, []), searchPassages: (_id: number, _revision: string, query: string) => {
      queries.push(query);
      return query.startsWith("correction") ? [passages[5]!] : [passages[0]!];
    } };
    const local = model(selection);
    const result = await createMeetingEvidence({ store: scopedStore, model: local })({ meetingId: id, question: "When is launch?", fits: byCount(7) });
    expect(result.mode).toBe("fts");
    expect(result.exhaustive).toBe(false);
    expect(new Set(result.sources.map(source => source.ref))).toEqual(new Set([0, 1, 4, 5, 6, 7]));
    expect(queries.some(query => query.startsWith("correction"))).toBe(true);
    expect(local.requests).toHaveLength(0);
  });

  it("rewrites a paraphrase once when lexical lookup is empty", async () => {
    const { store, id, passages } = meeting(long());
    const queries: string[] = [];
    const scopedStore = { ...fixedHits(store, []), searchPassages: (_id: number, _revision: string, query: string) => {
      queries.push(query);
      return query === "launch permissions" ? [passages[2]!] : [];
    } };
    const local = model(selection);
    const result = await createMeetingEvidence({ store: scopedStore, model: local })({ meetingId: id, question: "What approval prerequisites were mentioned?", fits: byCount(4) });
    expect(result.mode).toBe("fts");
    expect(local.requests.filter(request => instruction(request).startsWith("Rewrite"))).toHaveLength(1);
    expect(queries).toContain("launch permissions");
    expect(instruction(local.requests[0]!)).toContain("earlier answers are not factual evidence");
  });

  it("resolves follow-ups with at most four recent exchanges and drops oldest context to fit", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(selection);
    const history = Array.from({ length: 6 }, (_, index) => ({ question: `Earlier question ${index}`, answer: `Earlier answer ${index}` }));
    await createMeetingEvidence({ store: fixedHits(store, [passages[2]!]), model: local })({ meetingId: id, question: "And the deadline?", history, fits: byCount(4) });
    const rewrite = local.requests.find(request => instruction(request).startsWith("Rewrite"))!;
    expect(data(rewrite).history).toEqual(history.slice(-4));
    const huge = model(selection);
    await createMeetingEvidence({ store: fixedHits(store, [passages[2]!]), model: huge })({ meetingId: id, question: "And the deadline?", history: history.map(pair => ({ ...pair, answer: "Long context ".repeat(1000) })), fits: byCount(4) });
    expect(data(huge.requests[0]!).question).toBe("And the deadline?");
    expect(data(huge.requests[0]!).history).toEqual([]);
    expect(huge.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("scans every original passage for broad questions before returning an exhaustive result", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(selection);
    const result = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question: "Summarize all decisions", fits: byCount(3) });
    expect(result).toMatchObject({ mode: "scan", exhaustive: true, sufficient: true });
    const scanned = local.requests.filter(request => instruction(request).startsWith("Select"));
    expect(new Set(scanned.flatMap(request => data(request).sources!.map(source => source.id))))
      .toEqual(new Set(passages.flatMap(passage => passage.sources.map(source => source.id))));
    expect(local.requests.some(request => instruction(request).startsWith("Consolidate"))).toBe(true);
    expect(local.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    for (const request of local.requests) {
      const schema = request.schema as { properties: { sourceIds: { items: { enum: string[] } } } };
      expect(new Set(schema.properties.sourceIds.items.enum)).toEqual(new Set(data(request).sources!.map(source => source.id)));
    }
    expect(result.sources.map(source => source.ref)).toEqual([...result.sources.map(source => source.ref)].sort((a, b) => a - b));
  });

  it("honors forceScan for a targeted question and reports a completed absence distinctly", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(() => ({ sourceIds: [], sufficient: false }));
    const result = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question: "Which password was chosen?", forceScan: true, fits: byCount(2) });
    expect(result).toMatchObject({ mode: "scan", exhaustive: true, sufficient: false, sources: [] });
    expect(result.reason).toContain("complete Transcript");
  });

  it("scans the whole Meeting for final or latest temporal claims even when targeted hits exist", async () => {
    const { store, id, passages } = meeting(long());
    for (const question of ["What was the final launch date?", "What is the latest launch plan?", "What did we eventually choose?", "What date did we end up choosing?"]) {
      const local = model(selection);
      const result = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question, fits: byCount(3) });
      expect(result).toMatchObject({ mode: "scan", exhaustive: true });
    }
  });

  it("falls back to a whole-Meeting scan when initial retrieval cannot establish usable support", async () => {
    const { store, id, passages } = meeting(long());
    let scanning = false;
    const local = model(request => ({ ...selection(request), sufficient: scanning }));
    const result = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({
      meetingId: id, question: "Which launch permissions?", fits: byCount(3),
      onStage: stage => { if (stage === "scanning") scanning = true; },
    });
    // Force a budget smaller than the lexical candidate pool, so semantic selection can report insufficient support.
    const second = model(request => ({ ...selection(request), sufficient: scanning }));
    scanning = false;
    const checked = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!, passages[3]!]), model: second })({
      meetingId: id, question: "Which launch permissions?", fits: byCount(3),
      onStage: stage => { if (stage === "scanning") scanning = true; },
    });
    expect(checked).toMatchObject({ mode: "scan", exhaustive: true, sufficient: true });
    expect(second.requests.some(request => instruction(request).startsWith("Select"))).toBe(true);
    expect(result.exhaustive).toBe(false);
  });

  it("never mixes another Meeting or an old revision into model evidence", async () => {
    const { store, id } = meeting(long());
    const other = store.createMeeting({ app: "Other", startedAt: "2026-10-26" });
    const otherTranscript = { segments: [{ start: 0, end: 1, speaker: "Other secret speaker", text: "OTHER MEETING SECRET" }] };
    store.saveTranscript(other, otherTranscript);
    store.setMeetingState(other, "done");
    const otherPassages = store.listPassages(other, transcriptRevision(otherTranscript));
    const local = model(selection);
    const result = await createMeetingEvidence({ store: fixedHits(store, otherPassages), model: local })({ meetingId: id, question: "Which launch permissions?", fits: byCount(3) });
    expect(JSON.stringify(local.requests)).not.toContain("OTHER MEETING SECRET");
    expect(result.sources.every(source => source.speaker !== "Other secret speaker")).toBe(true);
    const stale = { getMeeting: store.getMeeting, searchPassages: store.searchPassages,
      listPassages: () => otherPassages.map(passage => ({ ...passage, meetingId: id, revision: "stale" })) };
    const rejected = await createMeetingEvidence({ store: stale, model: local })({ meetingId: id, question: "Which launch permissions?" });
    expect(rejected).toMatchObject({ exhaustive: false, sufficient: false, sources: [] });
    expect(rejected.reason).toContain("index is incomplete");
  });

  it("rejects model-selected unknown IDs after three bounded validation attempts", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(() => ({ sourceIds: ["unknown:0"], sufficient: true }));
    await expect(createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question: "Summarize all decisions", fits: byCount(2) })).rejects.toThrow("three attempts");
    expect(local.requests).toHaveLength(3);
    expect(instruction(local.requests[1]!)).toContain("Use only sourceIds");
  });

  it("fails on operational model errors rather than completing an absence answer", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(() => { throw new Error("Ollama model is missing"); });
    await expect(createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question: "Summarize all decisions", fits: byCount(2) })).rejects.toThrow("model is missing");
    expect(local.requests).toHaveLength(1);
  });

  it("reports call-limit and non-converging evidence budgets as incomplete rather than absent", async () => {
    const { store, id, passages } = meeting(long());
    const local = model(selection);
    const capped = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local, maxCalls: 1 })({ meetingId: id, question: "Summarize all decisions", fits: byCount(1) });
    expect(capped).toMatchObject({ exhaustive: false, sufficient: false, calls: 1, sources: [] });
    expect(capped.reason).toContain("model-call limit");
    const keepsEverything = model(request => ({ sourceIds: data(request).sources!.map(source => source.id), sufficient: true }));
    const stuck = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: keepsEverything })({ meetingId: id, question: "Summarize all decisions", fits: byCount(1) });
    expect(stuck).toMatchObject({ exhaustive: false, sufficient: false, sources: [] });
    expect(stuck.reason).toContain("without losing support");
  });

  it("allows a complete combined assessment to establish support after individually insufficient batches", async () => {
    const { store, id, passages } = meeting(long());
    let level = 0;
    const local = model(request => ({
      sourceIds: instruction(request).startsWith("Consolidate") ? [data(request).sources!.at(-1)!.id] : data(request).sources!.map(source => source.id),
      sufficient: level >= 2,
    }));
    const result = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({
      meetingId: id, question: "Summarize all decisions", fits: byCount(1),
      onStage: stage => { if (stage === "consolidating") level++; },
    });
    expect(level).toBeGreaterThanOrEqual(2);
    expect(result).toMatchObject({ mode: "scan", exhaustive: true, sufficient: true });
  });

  it("propagates cancellation and never labels an interrupted scan exhaustive", async () => {
    const { store, id, passages } = meeting(long());
    const controller = new AbortController();
    const local = model(request => { expect(request.signal).toBeDefined(); controller.abort(); return selection(request); });
    await expect(createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: local })({ meetingId: id, question: "Summarize all decisions", signal: controller.signal, fits: byCount(1) })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("distinguishes deadline and Transcript replacement from a completed scan finding no evidence", async () => {
    const { store, id, passages } = meeting(long());
    const delayed: TextModel = { async complete(request) { await new Promise(resolve => setTimeout(resolve, 15)); return { text: JSON.stringify(selection(request)), metadata: { model: "local:test", elapsedMs: 15 } }; } };
    const expired = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: delayed, deadlineMs: 5 })({ meetingId: id, question: "Summarize all decisions", fits: byCount(1) });
    expect(expired).toMatchObject({ exhaustive: false, sufficient: false, sources: [] });
    expect(expired.reason).toContain("deadline");
    const changed = model(request => { store.saveTranscript(id, short); return selection(request); });
    const stale = await createMeetingEvidence({ store: fixedHits(store, [passages[0]!]), model: changed })({ meetingId: id, question: "Summarize all decisions", fits: byCount(1) });
    expect(stale).toMatchObject({ exhaustive: false, sufficient: false, sources: [] });
    expect(stale.reason).toContain("changed");
  });

  it("never drops an oversized question to fit a source request", async () => {
    const { store, id } = meeting(long());
    const local = model(selection);
    const result = await createMeetingEvidence({ store, model: local })({ meetingId: id, question: "語".repeat(2000), fits: byCount(1) });
    expect(result).toMatchObject({ exhaustive: false, sufficient: false, sources: [], calls: 0 });
    expect(result.reason).toContain("budget");
  });
});
