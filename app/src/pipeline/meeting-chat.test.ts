import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/store.js";
import { transcriptRevision, type SourceFragment } from "./evidence.js";
import type { Transcript } from "./pipeline.js";
import type { TextModel, TextRequest } from "./language-model.js";
import { createMeetingChat, CHAT_ABSENT, CHAT_INCOMPLETE, CHAT_PROMPT_VERSION } from "./meeting-chat.js";
import { requestBytes } from "./model-request.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
const transcript: Transcript = { segments: [
  { start: 0, end: 5, speaker: "You", text: "I will write the permission guide by Thursday." },
  { start: 5, end: 10, speaker: "Speaker 1", text: "Friday is only a launch proposal; no launch date is agreed." },
] };
function setup(source = transcript) {
  const store = openStore(":memory:"); stores.push(store);
  const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27" });
  store.saveTranscript(id, source); store.setMeetingState(id, "done");
  return { store, id, expectedRevision: transcriptRevision(source) };
}
interface Data { question: string; history: { question: string; answer: string }[]; sources?: SourceFragment[]; exhaustive?: boolean }
const contents = (request: TextRequest) => JSON.parse(request.messages.at(-1)!.content) as { instruction: string; data: Data };
const isAnswer = (request: TextRequest) => contents(request).instruction.startsWith("Answer the question");
function fake(reply: (request: TextRequest, call: number) => unknown): TextModel & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return { requests, async complete(request) {
    requests.push(request); const result = reply(request, requests.length);
    return { text: typeof result === "string" ? result : JSON.stringify(result), metadata: { model: "local:test", elapsedMs: 1, promptTokens: 10, outputTokens: 4 } };
  } };
}
const positive = { text: "You will write the permission guide by Thursday.", sourceIds: ["0:0"], sufficient: true };
const question = "Who will write the permission guide?";
const input = (id: number, expectedRevision: string) => ({ meetingId: id, expectedRevision, question, history: [] });
const long = (): Transcript => ({ segments: Array.from({ length: 8 }, (_, index) => ({ start: index * 30, end: index * 30 + 25,
  speaker: index % 2 ? "Speaker 1" : "You", text: `Topic ${index} launch permissions. ` + "The local app retains original words and supports careful discussion. ".repeat(12) })) });

describe("grounded Meeting chat", () => {
  it("answers with original ordinal references and complete generation metadata", async () => {
    const { store, id, expectedRevision } = setup();
    const stages: string[] = [];
    const model = fake(() => positive);
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), onStage: stage => stages.push(stage) });
    expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
    expect(result.revision).toBe(expectedRevision);
    expect(result.generation).toMatchObject({ promptVersion: CHAT_PROMPT_VERSION, model: "local:test", calls: 1,
      promptTokens: 10, outputTokens: 4, retrievalCalls: 0, retrievalMode: "full", exhaustive: true });
    expect(stages).toEqual(["retrieving", "generating"]);
    expect(contents(model.requests[0]!).data.sources!.map(source => source.text)).toEqual(transcript.segments.map(segment => segment.text));
    const schema = model.requests[0]!.schema as { properties: { sourceIds: { items: { enum: string[] } } } };
    expect(schema.properties.sourceIds.items.enum).toEqual(["0:0", "1:0"]);
  });

  it("replaces unsupported model prose with a fixed honest limitation after complete evidence", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ text: "An invented owner and date", sourceIds: [], sufficient: false }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Who owns payroll?" });
    expect(result.answer).toEqual({ text: CHAT_ABSENT, refs: [], sufficient: false });
    expect(model.requests).toHaveLength(1);
  });

  it("uses only the latest four exchanges for follow-ups without treating old answers as facts", async () => {
    const { store, id, expectedRevision } = setup();
    const history = Array.from({ length: 6 }, (_, index) => ({ question: `Previous question ${index}`, answer: `Previous answer ${index}` }));
    const model = fake(() => positive);
    await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "And their deadline?", history });
    expect(contents(model.requests[0]!).data.history).toEqual(history.slice(-4));
    expect(contents(model.requests[0]!).instruction).toContain("earlier answers are not independent facts");
    expect(contents(model.requests[0]!).data.question).toBe("And their deadline?");
  });

  it("never supplies a generated Summary as factual evidence and allows a failed Summary's Transcript", async () => {
    const { store, id, expectedRevision } = setup();
    store.saveSummary(id, { tldr: "PRIVATE WRONG SUMMARY OWNER", participants: [{ speaker: "You", said: ["A made-up deadline"] }] });
    store.setMeetingState(id, "failed", "Summary generation failed");
    const model = fake(request => { expect(JSON.stringify(request)).not.toContain("PRIVATE WRONG SUMMARY OWNER"); return positive; });
    expect((await createMeetingChat({ store, model })(input(id, expectedRevision))).answer.sufficient).toBe(true);
  });

  it("retries malformed or unknown model citations at most three times with bounded static feedback", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake((_request, call) => call === 1 ? { ...positive, sourceIds: ["unknown:0"] } : call === 2 ? "not JSON" : positive);
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer.refs).toEqual([0]);
    expect(result.generation.calls).toBe(3);
    expect(result.generation.promptTokens).toBe(30);
    expect(contents(model.requests[1]!).instruction).toContain("Use only the original sourceIds");
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    const invalid = fake(() => ({ text: "A claim without evidence", sourceIds: [], sufficient: true }));
    await expect(createMeetingChat({ store, model: invalid })(input(id, expectedRevision))).rejects.toThrow("three attempts");
    expect(invalid.requests).toHaveLength(3);
  });

  it("performs one forced complete scan when initial targeted context cannot answer", async () => {
    const source = long(); source.segments[4]!.text = "You will write the launch guide by Wednesday. " + source.segments[4]!.text;
    const { store, id, expectedRevision } = setup(source);
    const passages = store.listPassages(id, expectedRevision);
    const scoped = { getMeeting: store.getMeeting, listPassages: store.listPassages, searchPassages: () => [passages[0]!] };
    let answers = 0;
    const model = fake(request => {
      const data = contents(request).data;
      if (isAnswer(request)) {
        answers++;
        return data.exhaustive ? { text: "You will write the launch guide by Wednesday.", sourceIds: [data.sources!.find(source => source.ref === 4)!.id], sufficient: true }
          : { text: "Not enough evidence", sourceIds: [], sufficient: false };
      }
      const selected = data.sources!.filter(source => source.ref === 4);
      return { sourceIds: selected.map(source => source.id), sufficient: selected.length > 0 };
    });
    const stages: string[] = [];
    const result = await createMeetingChat({ store: scoped, model })({ ...input(id, expectedRevision), question: "Who will write the launch guide?", onStage: stage => stages.push(stage) });
    expect(answers).toBe(2);
    expect(stages.filter(stage => stage === "retrieving")).toHaveLength(2);
    expect(result.answer).toEqual({ text: "You will write the launch guide by Wednesday.", refs: [4], sufficient: true });
    expect(result.generation).toMatchObject({ retrievalMode: "scan", exhaustive: true });
    expect(result.generation.retrievalCalls).toBe(model.requests.length - answers);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("distinguishes incomplete evidence budgets from a completed scan finding no answer", async () => {
    const { store, id, expectedRevision } = setup(long());
    const model = fake(request => contents(request).instruction.startsWith("Rewrite") ? { query: "launch permissions" } : { sourceIds: contents(request).data.sources!.map(source => source.id), sufficient: true });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Summarize all decisions" });
    expect(result.answer).toEqual({ text: CHAT_INCOMPLETE, refs: [], sufficient: false });
    expect(result.generation.exhaustive).toBe(false);
    expect(model.requests.every(request => !isAnswer(request))).toBe(true);
  });

  it("propagates connection errors instead of returning a completed absence answer", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => { throw new Error("Ollama is not running"); });
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("Ollama is not running");
    expect(model.requests).toHaveLength(1);
  });

  it("does not publish cancelled, timed-out or changed-Transcript output", async () => {
    const { store, id, expectedRevision } = setup();
    const controller = new AbortController();
    const cancelled = fake(request => { expect(request.signal).toBeDefined(); controller.abort(); return positive; });
    await expect(createMeetingChat({ store, model: cancelled })({ ...input(id, expectedRevision), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const late: TextModel = { async complete() { await new Promise(resolve => setTimeout(resolve, 15)); return { text: JSON.stringify(positive), metadata: { model: "local:test", elapsedMs: 15 } }; } };
    await expect(createMeetingChat({ store, model: late, deadlineMs: 5 })(input(id, expectedRevision))).rejects.toMatchObject({ name: "TimeoutError" });
    const changed = fake(() => { store.saveTranscript(id, { segments: [{ ...transcript.segments[0]!, text: "Replaced Transcript" }] }); return positive; });
    await expect(createMeetingChat({ store, model: changed })(input(id, expectedRevision))).rejects.toThrow("Transcript changed");
  });

  it("drops oldest history exchanges before evidence and never truncates the question or Transcript", async () => {
    const { store, id, expectedRevision } = setup();
    const history = Array.from({ length: 4 }, () => ({ question: "Old question", answer: "Large historical answer ".repeat(1000) }));
    const model = fake(() => positive);
    await createMeetingChat({ store, model })({ ...input(id, expectedRevision), history });
    expect(contents(model.requests[0]!).data.history).toEqual([]);
    expect(contents(model.requests[0]!).data.question).toBe(question);
    expect(contents(model.requests[0]!).data.sources!.map(source => source.text)).toEqual(transcript.segments.map(segment => segment.text));
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("requires trusted authorization to use a completed Transcript while Summary processing is pending", async () => {
    const { store, id, expectedRevision } = setup(); store.setMeetingState(id, "processing");
    const model = fake(() => positive);
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("not ready");
    const allowed = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), allowSummaryProcessing: true });
    expect(allowed.answer.sufficient).toBe(true);
    const empty = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27" }); store.setMeetingState(empty, "processing");
    await expect(createMeetingChat({ store, model })({ ...input(empty, transcriptRevision({ segments: [] })), allowSummaryProcessing: true })).rejects.toThrow("not ready");
  });
});
