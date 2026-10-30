import { expect, it, vi } from "vitest";
import { createGeminiChat, createGeminiSummariser } from "./gemini-pipeline.js";
import { openStore } from "../store/store.js";
import { transcriptRevision } from "./evidence.js";
import type { TextModel, TextRequest } from "./language-model.js";
import { PipelineRunner } from "./runner.js";
import { GEMINI_INPUT_BYTES } from "./gemini.js";
import { requestBytes } from "./model-request.js";

const transcript = { segments: [
  { start: 0, end: 2, speaker: "You", text: "I propose Thursday for release." },
  { start: 3, end: 5, speaker: "Speaker 1", text: "The final decision is Friday. No calendar date is agreed." },
] };
const extracted = { points: [
  { speaker: "You", text: "Proposed Thursday for release.", sourceIds: ["0:0"] },
  { speaker: "Speaker 1", text: "The final decision is Friday; no calendar date is agreed.", sourceIds: ["1:0"] },
], omittedSourceIds: [] };
const final = { tldr: { text: "Friday is the final release decision; the calendar date is unresolved.", pointIds: [1] }, points: [
  { speaker: "You", text: "Initially proposed Thursday for release.", covers: [0] },
  { speaker: "Speaker 1", text: "Confirmed Friday as the final decision, with no calendar date agreed.", covers: [1] },
] };
function modelFor(answers: unknown[]) {
  const requests: TextRequest[] = [];
  const complete = vi.fn<TextModel["complete"]>(async request => {
    requests.push(request);
    return { text: JSON.stringify(answers[Math.min(requests.length - 1, answers.length - 1)]), metadata: { model: "gemini-test", elapsedMs: 1, promptTokens: 10, outputTokens: 20 } };
  });
  return { complete, requests };
}
function meeting() {
  const store = openStore(":memory:");
  const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-30T12:00:00Z" });
  store.saveTranscript(id, transcript); store.setMeetingState(id, "done");
  return { store, id, input: { meetingId: id, question: "What was the final release plan?", history: [], expectedRevision: transcriptRevision(transcript) } };
}

it("creates readable points and TLDR with original ordinal evidence and provider metadata", async () => {
  const model = modelFor([extracted, final]);
  const output = await createGeminiSummariser({ model })(transcript);
  expect(output.tldr).toBe(final.tldr.text);
  expect(output.evidence).toEqual({ revision: transcriptRevision(transcript), tldr: [1], participants: [{ speaker: "You", said: [[0]] }, { speaker: "Speaker 1", said: [[1]] }] });
  expect(output.generation).toMatchObject({ provider: "gemini", promptVersion: "gemini-summary-v1", calls: 2 });
  expect(model.requests.every(r => requestBytes(r) <= GEMINI_INPUT_BYTES)).toBe(true);
});

it.each([
  { ...extracted, points: [{ ...extracted.points[0], sourceIds: ["unknown"] }] },
  { ...extracted, points: [{ ...extracted.points[0], sourceIds: ["1:0"] }] },
  { points: [extracted.points[0]], omittedSourceIds: [] },
])("rejects unknown sources, borrowed speech and incomplete extraction", async bad => {
  const model = modelFor([bad]);
  await expect(createGeminiSummariser({ model })(transcript)).rejects.toThrow("three attempts");
  expect(model.complete).toHaveBeenCalledTimes(3);
});

it("preserves the saved Summary after repeated Gemini consolidation coverage failures", async () => {
  const f = meeting();
  f.store.saveSummary(f.id, { tldr: "Previous Summary", participants: [{ speaker: "You", said: ["Previous point"] }] });
  const model = modelFor([extracted, { ...final, points: [final.points[0]] }]);
  const runner = new PipelineRunner({ transcribe: async () => transcript, summarise: createGeminiSummariser({ model }) }, f.store);
  await runner.resummarise(f.id, transcript);
  expect(f.store.getMeeting(f.id)?.summary?.tldr).toBe("Previous Summary");
  expect(f.store.getMeeting(f.id)?.state).toBe("failed");
  expect(model.complete).toHaveBeenCalledTimes(4);
  f.store.close();
});

it("publishes synthesised Chat with derived citations and question-only follow-up context", async () => {
  const f = meeting();
  const model = modelFor([{ status: "answered", claims: [{ text: "Friday was selected; no calendar date was agreed.", sourceIds: ["1:0"] }] }]);
  const result = await createGeminiChat({ store: f.store, model })({ ...f.input, question: "And its date?", history: [{ question: "What was the release plan?", answer: "UNTRUSTED_ASSISTANT_FACT" }] });
  expect(result.answer).toEqual({ text: "Friday was selected; no calendar date was agreed.", refs: [1], sufficient: true });
  expect(result.generation).toMatchObject({ provider: "gemini", retrievalMode: "full", exhaustive: true, calls: 1 });
  expect(JSON.stringify(model.requests)).not.toContain("UNTRUSTED_ASSISTANT_FACT");
  f.store.close();
});

it.each(["not-established", "unverified"])("keeps %s distinct from supported answers", async status => {
  const f = meeting(), model = modelFor([{ status, claims: [] }]);
  const result = await createGeminiChat({ store: f.store, model })(f.input);
  expect(result.answer.sufficient).toBe(false);
  expect(result.answer.refs).toEqual([]);
  expect(result.answer.text).toContain(status === "not-established" ? "Not established" : "reliable answer");
  f.store.close();
});

it("does not publish unknown citations or uncited Chat prose", async () => {
  const f = meeting();
  for (const sourceIds of [[], ["another-meeting:0"]]) {
    const model = modelFor([{ status: "answered", claims: [{ text: "Unsupported", sourceIds }] }]);
    await expect(createGeminiChat({ store: f.store, model })(f.input)).rejects.toThrow("three attempts");
    expect(model.complete).toHaveBeenCalledTimes(3);
  }
  f.store.close();
});

it("rejects cancellation, unavailable Transcripts and revision changes before publication", async () => {
  const f = meeting(), controller = new AbortController(); controller.abort();
  const model = modelFor([extracted]);
  await expect(createGeminiSummariser({ model })(transcript, { signal: controller.signal })).rejects.toThrow();
  expect(model.complete).not.toHaveBeenCalled();
  f.store.setMeetingState(f.id, "processing");
  await expect(createGeminiChat({ store: f.store, model })(f.input)).rejects.toThrow("not ready");
  f.store.setMeetingState(f.id, "done");
  const changing: TextModel = { complete: async () => {
    f.store.saveTranscript(f.id, { segments: [] });
    return { text: JSON.stringify({ status: "answered", claims: [{ text: "Friday", sourceIds: ["1:0"] }] }), metadata: { model: "gemini-test", elapsedMs: 1 } };
  } };
  await expect(createGeminiChat({ store: f.store, model: changing })(f.input)).rejects.toThrow("Transcript changed");
  f.store.close();
});

it("visits every long-Transcript batch before synthesising an answer from a distant final correction", async () => {
  const f = meeting();
  const long = { segments: Array.from({ length: 240 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, speaker: "You", text: ("Synthetic background discussion without a release date. ").repeat(20) })) };
  long.segments.push({ start: 1200, end: 1204, speaker: "Speaker 1", text: "The final decision is Friday." });
  f.store.saveTranscript(f.id, long);
  const seen = new Set<string>();
  const requests: TextRequest[] = [];
  const model: TextModel = { complete: async request => {
    requests.push(request);
    const payload = JSON.parse(request.messages.at(-1)!.content);
    const sources = payload.data.sources as { id: string; text: string }[];
    const selection = payload.task.startsWith("Select original");
    if (selection) sources.forEach(source => seen.add(source.id));
    const selected = sources.filter(source => source.text.includes("Friday"));
    return { text: JSON.stringify(selection ? { sourceIds: selected.map(source => source.id) } : { status: "answered", claims: [{ text: "The final decision was Friday.", sourceIds: selected.map(source => source.id) }] }), metadata: { model: "gemini-test", elapsedMs: 1 } };
  } };
  const result = await createGeminiChat({ store: f.store, model })({ ...f.input, expectedRevision: transcriptRevision(long) });
  expect(result.answer.refs).toEqual([240]);
  expect(result.generation).toMatchObject({ retrievalMode: "scan", exhaustive: true });
  expect(seen.has("0:0")).toBe(true);
  expect(seen.has("240:0")).toBe(true);
  expect(new Set([...seen].map(id => id.split(":")[0])).size).toBe(241);
  expect(requests.every(request => requestBytes(request) <= GEMINI_INPUT_BYTES)).toBe(true);
  f.store.close();
});

it("does not turn an interrupted long scan into an absence finding", async () => {
  const f = meeting();
  const long = { segments: Array.from({ length: 240 }, (_, index) => ({ start: index * 5, end: index * 5 + 4, speaker: "You", text: "Synthetic filler. ".repeat(60) })) };
  f.store.saveTranscript(f.id, long);
  let calls = 0;
  const model: TextModel = { complete: async () => {
    if (++calls === 2) throw new Error("Gemini quota reached");
    return { text: '{"sourceIds":[]}', metadata: { model: "gemini-test", elapsedMs: 1 } };
  } };
  await expect(createGeminiChat({ store: f.store, model })({ ...f.input, expectedRevision: transcriptRevision(long) })).rejects.toThrow("quota reached");
  expect(calls).toBe(2);
  f.store.close();
});

it("aborts a Summary at its deadline without accepting a late model response", async () => {
  const model: TextModel = { complete: async request => new Promise((_resolve, reject) => {
    request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
  }) };
  await expect(createGeminiSummariser({ model, deadlineMs: 10 })(transcript)).rejects.toThrow();
});
