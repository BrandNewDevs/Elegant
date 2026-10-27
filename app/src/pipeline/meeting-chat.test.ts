import { afterEach, describe, expect, it } from "vitest";
import { openStore, type Store } from "../store/store.js";
import { transcriptRevision } from "./evidence.js";
import type { Transcript } from "./pipeline.js";
import type { TextModel, TextRequest } from "./language-model.js";
import { createMeetingChat, CHAT_ABSENT, CHAT_INCOMPLETE, CHAT_UNVERIFIED, CHAT_PROMPT_VERSION } from "./meeting-chat.js";
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
interface Data { question: string; originalQuestion?: string; priorUserQuestion?: string; history?: { question: string; answer: string }[];
  sources?: { id: string; speaker: string; text: string; ref?: number }[]; exhaustive?: boolean }
const contents = (request: TextRequest) => JSON.parse(request.messages.at(-1)!.content) as { instruction: string; data: Data };
const properties = (request: TextRequest) => (request.schema as { properties: object }).properties;
const isAnswer = (request: TextRequest) => "sentenceIds" in properties(request);
const isRewrite = (request: TextRequest) => "question" in properties(request);
function fake(reply: (request: TextRequest, call: number) => unknown, options: {
  resolve?: (request: TextRequest, call: number) => unknown;
} = {}): TextModel & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return { requests, async complete(request) {
    requests.push(request);
    const result = isRewrite(request) ? options.resolve?.(request, requests.length) ?? { question: "When will You finish the permission guide?" }
      : reply(request, requests.length);
    return { text: typeof result === "string" ? result : JSON.stringify(result), metadata: { model: "local:test", elapsedMs: 1, promptTokens: 10, outputTokens: 4 } };
  } };
}
const positive = { sentenceIds: ["0:0/s0"], sufficient: true };
const quote = "You: “I will write the permission guide by Thursday.”";
const question = "Who will write the permission guide?";
const input = (id: number, expectedRevision: string) => ({ meetingId: id, expectedRevision, question, history: [] });
const long = (): Transcript => ({ segments: Array.from({ length: 8 }, (_, index) => ({ start: index * 30, end: index * 30 + 25,
  speaker: index % 2 ? "Speaker 1" : "You", text: `Topic ${index} launch permissions. ` + "The local app retains original words and supports careful discussion. ".repeat(12) })) });

describe("extractive Meeting chat", () => {
  it("quotes original speech under its actual speaker with references and generation metadata", async () => {
    const { store, id, expectedRevision } = setup();
    const stages: string[] = [];
    const model = fake(() => positive);
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), onStage: stage => stages.push(stage) });
    expect(result.answer).toEqual({ text: quote, refs: [0], sufficient: true });
    expect(result.revision).toBe(expectedRevision);
    expect(result.generation).toMatchObject({ promptVersion: CHAT_PROMPT_VERSION, model: "local:test", calls: 1,
      promptTokens: 10, outputTokens: 4, retrievalCalls: 0, retrievalMode: "full", exhaustive: true });
    expect(stages).toEqual(["retrieving", "generating"]);
    const payload = contents(model.requests[0]!).data;
    expect(payload.sources).toEqual(transcript.segments.map((source, i) => ({ id: `${i}:0/s0`, speaker: source.speaker, text: source.text })));
    const schema = model.requests[0]!.schema as { properties: { sentenceIds: { items: { enum: string[] } } } };
    expect(schema.properties.sentenceIds.items.enum).toEqual(["0:0/s0", "1:0/s0"]);
    expect(properties(model.requests[0]!)).not.toHaveProperty("text");
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("orders selected sentences chronologically, deduplicates them and derives citations", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ sentenceIds: ["1:0/s0", "0:0/s0", "1:0/s0"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What was discussed?" });
    expect(result.answer).toEqual({ text: quote + "\nSpeaker 1: “Friday is only a launch proposal; no launch date is agreed.”", refs: [0, 1], sufficient: true });
    expect(model.requests).toHaveLength(1);
  });

  it("keeps explicit negative answers useful without inventing an owner or deadline", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "Speaker 2", text: "Please do not list me as the owner." },
      { start: 5, end: 10, speaker: "You", text: "The guide is unassigned and we have not set a deadline." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ sentenceIds: ["1:0/s0"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Who owns the guide?" });
    expect(result.answer).toEqual({ text: "You: “The guide is unassigned and we have not set a deadline.”", refs: [1], sufficient: true });
    expect(result.answer.text).not.toContain("Speaker 2:");
  });

  it("keeps a review commitment beside its writing limitation when either sentence is selected", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "You", text: "I cannot write the guide." },
      { start: 5, end: 10, speaker: "Speaker 1", text: "I can commit to reviewing the guide after someone writes it. I am not committing to writing it." },
      { start: 10, end: 15, speaker: "Speaker 2", text: "We also discussed an unrelated keyboard." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ sentenceIds: ["1:0/s1"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Who agreed to review the guide?" });
    expect(result.answer).toEqual({ text: `Speaker 1: “${source.segments[1]!.text}”`, refs: [1], sufficient: true });
    expect(result.answer.text).not.toContain("You:");
    expect(result.answer.text).not.toContain("Speaker 2:");
    expect(result.answer.text).not.toContain("keyboard");
    expect(model.requests).toHaveLength(1);
  });

  it("publishes each selected original fragment once in chronology even when several of its sentences were selected", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "You", text: "Monday was provisional. The final decision is Friday." },
      { start: 5, end: 10, speaker: "Speaker 1", text: "I agree to Friday. I will prepare the guide by Wednesday." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ sentenceIds: ["1:0/s1", "0:0/s1", "1:0/s0", "1:0/s1"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What is the final plan?" });
    expect(result.answer).toEqual({ text: `You: “${source.segments[0]!.text}”\nSpeaker 1: “${source.segments[1]!.text}”`, refs: [0, 1], sufficient: true });
  });

  it("checks the published fragment rather than an isolated selection for an explicit budget value", async () => {
    const text = "The budget is $500. We will review it next week.";
    const { store, id, expectedRevision } = setup({ segments: [{ start: 0, end: 5, speaker: "You", text }] });
    const model = fake(() => ({ sentenceIds: ["0:0/s1"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What is the project budget?" });
    expect(result.answer).toEqual({ text: `You: “${text}”`, refs: [0], sufficient: true });
    expect(model.requests).toHaveLength(1);
  });

  it("allows reported speech mentioning another Participant without changing who said it", async () => {
    const source: Transcript = { segments: [{ start: 0, end: 5, speaker: "You", text: "Speaker 1 promised to review the guide." }] };
    const { store, id, expectedRevision } = setup(source);
    const result = await createMeetingChat({ store, model: fake(() => positive) })({ ...input(id, expectedRevision), question: "Who promised a guide review?" });
    expect(result.answer.text).toBe("You: “Speaker 1 promised to review the guide.”");
    expect(result.answer.sufficient).toBe(true);
  });

  it("cannot replace the app-authored speaker or literal speech with model prose", async () => {
    const { store, id, expectedRevision } = setup();
    for (const injected of [
      { ...positive, text: "Speaker 2 accepted the task by Friday." },
      { ...positive, speaker: "Speaker 2" },
      { ...positive, sourceIds: ["1:0"] },
    ]) {
      const model = fake(() => injected);
      await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("never write answer text");
      expect(model.requests).toHaveLength(3);
      expect(model.requests.every(isAnswer)).toBe(true);
    }
  });

  it("returns a fixed absence limitation after complete evidence without publishing unsupported prose", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ sentenceIds: [], sufficient: false }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Who owns payroll?" });
    expect(result.answer).toEqual({ text: CHAT_ABSENT, refs: [], sufficient: false });
    expect(model.requests).toHaveLength(1);
  });

  it("treats an empty claimed-positive selection as unverifiable without publishing an absence claim", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ sentenceIds: [], sufficient: true }));
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer).toEqual({ text: CHAT_UNVERIFIED, refs: [], sufficient: false });
    expect(model.requests).toHaveLength(1);
  });

  it("corrects malformed selections at most three times using bounded non-content feedback", async () => {
    const { store, id, expectedRevision } = setup();
    let generations = 0;
    const model = fake(() => ++generations === 1 ? { sentenceIds: ["unknown/s0"], sufficient: true }
      : generations === 2 ? "not JSON" : positive);
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer.text).toBe(quote);
    expect(generations).toBe(3);
    expect(contents(model.requests[1]!).instruction).toContain("supplied original sentenceIds");
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it.each([
    { sentenceIds: ["unknown/s0"], sufficient: true },
    { sentenceIds: [0], sufficient: true }, { sentenceIds: null, sufficient: true },
    { sentenceIds: ["0:0/s0"], sufficient: "yes" }, { sentenceIds: Array(65).fill("0:0/s0"), sufficient: true },
  ])("rejects invalid answer selections without publishing them", async selection => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => selection);
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("three attempts");
    expect(model.requests).toHaveLength(3);
    expect(model.requests.every(isAnswer)).toBe(true);
  });

  it("supplies all original context once and places the question after the evidence", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(request => {
      const payload = contents(request).data;
      expect(payload.sources!.map(source => source.text)).toEqual(transcript.segments.map(source => source.text));
      expect(request.messages.at(-1)!.content.indexOf(transcript.segments[1]!.text)).toBeLessThan(request.messages.at(-1)!.content.indexOf(question));
      return positive;
    });
    expect((await createMeetingChat({ store, model })(input(id, expectedRevision))).answer.text).toBe(quote);
    expect(model.requests).toHaveLength(1);
  });

  it("retains the whole original sentence including negation instead of selecting an invented sub-clause", async () => {
    const sentence = "This is not an accepted commitment: " + "the original conditional wording remains available with all its qualifications ".repeat(5) + ".";
    const { store, id, expectedRevision } = setup({ segments: [{ start: 0, end: 5, speaker: "You", text: sentence }] });
    let attempts = 0;
    const model = fake(request => {
      expect(contents(request).data.sources!.map(source => source.text)).toEqual([sentence]);
      return { sentenceIds: [++attempts === 1 ? "0:0/s0/affirmative-clause" : "0:0/s0"], sufficient: true };
    });
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer.text).toBe(`You: “${sentence}”`);
    expect(result.generation.calls).toBe(2);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("quotes selected later corrections without authoring a replacement decision", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "You", text: "Monday is provisional." },
      { start: 5, end: 10, speaker: "Speaker 1", text: "Final decision: Friday replaces Monday." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ sentenceIds: ["1:0/s0"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What is the final launch day?" });
    expect(result.answer).toEqual({ text: "Speaker 1: “Final decision: Friday replaces Monday.”", refs: [1], sufficient: true });
    expect(model.requests).toHaveLength(1);
  });

  it.each(["What is its deadline?", "When will they finish it?", "And the deadline?"])("resolves a contextual follow-up before answering: %s", async asked => {
    const { store, id, expectedRevision } = setup();
    const history = [{ question, answer: "You will write the guide. Speaker 1 will review it on Friday." }];
    const model = fake(request => {
      expect(contents(request).data.question).toBe("When will You finish the permission guide?");
      expect(contents(request).data.originalQuestion).toBe(asked);
      expect(contents(request).data.priorUserQuestion).toBe(question);
      return positive;
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: asked, history });
    expect(result.answer.text).toBe(quote);
    expect(model.requests.filter(isRewrite)).toHaveLength(1);
    expect(result.generation.calls).toBe(2);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it.each(["not JSON", JSON.stringify({ question: "When is that due?" }), JSON.stringify({ question: "" })])(
    "preserves original follow-up intent after one unusable rewrite: %s", async rewrite => {
      const { store, id, expectedRevision } = setup();
      const asked = "When is that due?";
      const model = fake(request => {
        expect(contents(request).data.question).toBe(`Previous subject question: ${question}\nCurrent question: ${asked}`);
        expect(contents(request).data.priorUserQuestion).toBe(question);
        return positive;
      }, { resolve: () => rewrite });
      const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: asked,
        history: [{ question, answer: "A previous answer is not evidence." }] });
      expect(result.answer.text).toBe(quote);
      expect(model.requests.filter(isRewrite)).toHaveLength(1);
      expect(result.generation.calls).toBe(2);
      expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    });

  it("does not truncate oversized original questions to manufacture follow-up context", async () => {
    const { store, id, expectedRevision } = setup();
    const asked = "When is that due? " + "details ".repeat(190);
    const prior = "Who will write the guide? " + "context ".repeat(190);
    const model = fake(() => { throw new Error("No answer should be generated"); }, { resolve: () => ({ question: "When is that due?" }) });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: asked,
      history: [{ question: prior, answer: "" }] });
    expect(result.answer).toEqual({ text: CHAT_INCOMPLETE, refs: [], sufficient: false });
    expect(model.requests.filter(isAnswer)).toHaveLength(0);
    expect(model.requests.filter(isRewrite).length).toBeLessThanOrEqual(1);
  });

  it("uses the latest four user questions for selection while keeping assistant facts out", async () => {
    const { store, id, expectedRevision } = setup();
    const history = Array.from({ length: 6 }, (_, i) => ({ question: `Old question ${i}`, answer: `Old answer ${i}` }));
    const model = fake(request => { expect(contents(request).data.history).toEqual(history.slice(-4).map(({ question }) => ({ question }))); return positive; });
    await createMeetingChat({ store, model })({ ...input(id, expectedRevision), history });
    const huge = fake(request => { expect(contents(request).data.history).toEqual(history.slice(-4).map(({ question }) => ({ question })));
      expect(JSON.stringify(request)).not.toContain("Large answer"); return positive; });
    await createMeetingChat({ store, model: huge })({ ...input(id, expectedRevision), history: history.map(pair => ({ ...pair, answer: "Large answer ".repeat(1000) })) });
    expect(huge.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("drops whole oldest user-question context when the complete selection request would exceed its budget", async () => {
    const { store, id, expectedRevision } = setup();
    const history = Array.from({ length: 4 }, (_, index) => ({ question: `PRIOR_${index} ` + "context ".repeat(240), answer: "A stored answer" }));
    const model = fake(request => {
      const retained = contents(request).data.history!;
      expect(retained.length).toBeLessThan(4);
      expect(retained.length).toBeGreaterThan(0);
      expect(retained).toEqual(history.slice(-retained.length).map(({ question }) => ({ question })));
      expect(contents(request).data.sources!.map(source => source.text)).toEqual(transcript.segments.map(source => source.text));
      return positive;
    });
    expect((await createMeetingChat({ store, model })({ ...input(id, expectedRevision), history })).answer.text).toBe(quote);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("uses full exchanges for one intent rewrite, then excludes assistant detours from source selection", async () => {
    const { store, id, expectedRevision } = setup();
    const history = [{ question: "Who will write the permission guide?", answer: "PRIVATE DETOUR about deleting audio on Friday" }];
    const model = fake(request => {
      const payload = contents(request).data;
      expect(payload.question).toBe("When will You finish the permission guide?");
      expect(payload.history).toEqual([{ question: history[0]!.question }]);
      expect(JSON.stringify(request)).not.toContain("PRIVATE DETOUR");
      expect(payload.priorUserQuestion).toBe(history[0]!.question);
      return positive;
    }, { resolve: request => {
      expect(contents(request).data.history).toEqual(history);
      expect(JSON.stringify(request)).toContain("PRIVATE DETOUR");
      return { question: "When will You finish the permission guide?" };
    } });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When is that due?", history });
    expect(result.answer.text).toBe(quote);
    expect(model.requests.filter(isRewrite)).toHaveLength(1);
    expect(model.requests.filter(isAnswer)).toHaveLength(1);
  });

  it("keeps unrelated history out of follow-up intent and never uses a Summary as factual evidence", async () => {
    const { store, id, expectedRevision } = setup();
    store.saveSummary(id, { tldr: "PRIVATE WRONG SUMMARY", participants: [{ speaker: "You", said: ["Invented deadline"] }] });
    store.setMeetingState(id, "failed", "Summary failed");
    const history = [{ question: "Unrelated prior question ".repeat(80), answer: "PRIVATE PRIOR ANSWER" }];
    const model = fake(request => {
      expect(contents(request).data).not.toHaveProperty("priorUserQuestion");
      expect(contents(request).data.history).toEqual(history.map(({ question }) => ({ question })));
      expect(JSON.stringify(request)).not.toContain("PRIVATE PRIOR ANSWER");
      expect(JSON.stringify(request)).not.toContain("PRIVATE WRONG SUMMARY");
      return positive;
    });
    expect((await createMeetingChat({ store, model })({ ...input(id, expectedRevision), history })).answer.text).toBe(quote);
  });

  it("rejects another Participant substituted for a requested person", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => positive);
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What did Mallory commit to?" });
    expect(result.answer).toEqual({ text: CHAT_UNVERIFIED, refs: [], sufficient: false });
    expect(model.requests).toHaveLength(3);
    expect(model.requests.every(isAnswer)).toBe(true);
  });

  it("does not accept a weekday as a requested calendar date", async () => {
    const source: Transcript = { segments: [{ start: 0, end: 5, speaker: "You", text: "Friday is the agreed launch day." },
      { start: 5, end: 10, speaker: "You", text: "We did not set a calendar date for Friday." }] };
    const { store, id, expectedRevision } = setup(source);
    const bad = fake(() => positive);
    expect((await createMeetingChat({ store, model: bad })({ ...input(id, expectedRevision), question: "What calendar date is launch?" })).answer.text).toBe(CHAT_UNVERIFIED);
    const good = fake(() => ({ sentenceIds: ["1:0/s0"], sufficient: true }));
    expect((await createMeetingChat({ store, model: good })({ ...input(id, expectedRevision), question: "What calendar date is launch?" })).answer.text)
      .toBe("You: “We did not set a calendar date for Friday.”");
  });

  it.each(["2026-10-30", "30 October 2026", "October 30th", "30/10/2026"])("accepts an actual original calendar date: %s", async value => {
    const { store, id, expectedRevision } = setup({ segments: [{ start: 0, end: 5, speaker: "You", text: `Launch is ${value}.` }] });
    expect((await createMeetingChat({ store, model: fake(() => positive) })({ ...input(id, expectedRevision), question: "What is the calendar date of launch?" })).answer.sufficient).toBe(true);
  });

  it("does not substitute an unrelated task count for a budget value", async () => {
    const { store, id, expectedRevision } = setup({ segments: [{ start: 0, end: 5, speaker: "You", text: "I have three testing tasks." }] });
    const result = await createMeetingChat({ store, model: fake(() => positive) })({ ...input(id, expectedRevision), question: "What is the project budget?" });
    expect(result.answer.text).toBe(CHAT_UNVERIFIED);
  });

  it.each(["The budget is $500.", "five hundred dollars", "five hundred", "Five hundred was approved for it.", "Five hundred is the allocation.", "We approved five hundred for it.", "We allocated five hundred to it.", "We set aside five hundred for it.", "1/2", "half of the budget", "The budget is zero.", "No budget was specified."])("retains an original amount or explicit budget limit: %s", async text => {
    const { store, id, expectedRevision } = setup({ segments: [{ start: 0, end: 5, speaker: "You", text }] });
    expect((await createMeetingChat({ store, model: fake(() => positive) })({ ...input(id, expectedRevision), question: "What is the project budget?" })).answer.sufficient).toBe(true);
  });

  it("performs one complete-scan fallback after an unsupported targeted selection", async () => {
    const source = long(); source.segments[4]!.text = "I will write the launch guide by Wednesday. " + source.segments[4]!.text;
    const { store, id, expectedRevision } = setup(source);
    const passages = store.listPassages(id, expectedRevision);
    const scoped = { getMeeting: store.getMeeting, listPassages: store.listPassages, searchPassages: () => [passages[0]!] };
    let answers = 0;
    const model = fake(request => {
      const payload = contents(request).data;
      if (isAnswer(request)) {
        answers++;
        return payload.exhaustive ? { sentenceIds: [payload.sources!.find(source => source.text.startsWith("I will write"))!.id], sufficient: true }
          : { sentenceIds: [], sufficient: false };
      }
      const selected = payload.sources!.filter(source => source.ref === 4);
      return { sourceIds: (selected.length ? selected : payload.sources!.slice(0, 1)).map(source => source.id) };
    });
    const stages: string[] = [];
    const result = await createMeetingChat({ store: scoped, model })({ ...input(id, expectedRevision), question: "Who will write the launch guide?", onStage: stage => stages.push(stage) });
    expect(answers).toBe(2);
    expect(stages.filter(stage => stage === "retrieving")).toHaveLength(2);
    expect(result.answer.text).toBe(`You: “${source.segments[4]!.text}”`);
    expect(result.answer.refs).toEqual([4]);
    expect(result.generation).toMatchObject({ retrievalMode: "scan", exhaustive: true });
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("reports incomplete evidence rather than dropping speech to satisfy a budget", async () => {
    const { store, id, expectedRevision } = setup(long());
    const model = fake(request => contents(request).instruction.startsWith("Rewrite") ? { query: "launch permissions" }
      : { sourceIds: contents(request).data.sources!.map(source => source.id) });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Summarize all decisions" });
    expect(result.answer).toEqual({ text: CHAT_INCOMPLETE, refs: [], sufficient: false });
    expect(result.generation.exhaustive).toBe(false);
    expect(model.requests.every(request => !isAnswer(request))).toBe(true);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("propagates connection failures without blind retries", async () => {
    const { store, id, expectedRevision } = setup();
    const down = fake(() => { throw new Error("Ollama is unavailable"); });
    await expect(createMeetingChat({ store, model: down })(input(id, expectedRevision))).rejects.toThrow("Ollama is unavailable");
    expect(down.requests).toHaveLength(1);
  });

  it("does not publish cancelled, timed-out or changed-Transcript output", async () => {
    const { store, id, expectedRevision } = setup();
    const controller = new AbortController();
    const cancelled = fake(() => { controller.abort(); return positive; });
    await expect(createMeetingChat({ store, model: cancelled })({ ...input(id, expectedRevision), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    const late: TextModel = { async complete() { await new Promise(resolve => setTimeout(resolve, 15)); return { text: JSON.stringify(positive), metadata: { model: "local:test", elapsedMs: 15 } }; } };
    await expect(createMeetingChat({ store, model: late, deadlineMs: 5 })(input(id, expectedRevision))).rejects.toMatchObject({ name: "TimeoutError" });
    const changed = fake(() => { store.saveTranscript(id, { segments: [{ ...transcript.segments[0]!, text: "Replaced Transcript" }] }); return positive; });
    await expect(createMeetingChat({ store, model: changed })(input(id, expectedRevision))).rejects.toThrow("Transcript changed");

  });

  it("requires trusted authorization to use a completed Transcript during Summary processing", async () => {
    const { store, id, expectedRevision } = setup(); store.setMeetingState(id, "processing");
    const model = fake(() => positive);
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("not ready");
    expect((await createMeetingChat({ store, model })({ ...input(id, expectedRevision), allowSummaryProcessing: true })).answer.sufficient).toBe(true);
    const empty = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27" }); store.setMeetingState(empty, "processing");
    await expect(createMeetingChat({ store, model })({ ...input(empty, transcriptRevision({ segments: [] })), allowSummaryProcessing: true })).rejects.toThrow("not ready");
  });

  it("validates Meeting IDs and question size before model work", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => positive);
    for (const asked of ["", " ", "x".repeat(2001)]) await expect(createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: asked })).rejects.toThrow("2000 characters");
    await expect(createMeetingChat({ store, model })(input(0, expectedRevision))).rejects.toThrow("Invalid Meeting ID");
    expect(model.requests).toHaveLength(0);
  });
});
