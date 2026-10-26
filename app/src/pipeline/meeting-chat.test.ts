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
interface Data { question: string; originalQuestion?: string; priorUserQuestion?: string; history: { question: string; answer: string }[]; sources?: SourceFragment[]; exhaustive?: boolean }
const contents = (request: TextRequest) => JSON.parse(request.messages.at(-1)!.content) as { instruction: string; data: Data };
const isAnswer = (request: TextRequest) => "text" in (request.schema as { properties: object }).properties;
function auditReply(request: TextRequest, ids = contents(request).data.sources!.slice(0, 1).map(source => source.id), supported = true) {
  const originals = new Map(contents(request).data.sources!.map(source => [source.id, source]));
  return { checks: ids.map(id => {
    const source = originals.get(id)!;
    return { speaker: source.speaker, sourceId: id, quote: [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(source.text)][0]!.segment.trim().slice(0, 200), relation: "supports" };
  }), addressesQuestion: true, supported };
}
function auditIds(request: TextRequest): string[] {
  return (request.schema as { properties: { checks: { items: { properties: { sourceId: { enum: string[] } } } } } }).properties.checks.items.properties.sourceId.enum;
}

function fake(reply: (request: TextRequest, call: number) => unknown, options: {
  audit?: (request: TextRequest, call: number) => unknown;
  resolve?: (request: TextRequest, call: number) => unknown;
} = {}): TextModel & { requests: TextRequest[] } {
  const requests: TextRequest[] = [];
  return { requests, async complete(request) {
    requests.push(request);
    const resolving = "question" in (request.schema as { properties: object }).properties;
    const auditing = "supported" in (request.schema as { properties: object }).properties;
    const result = resolving ? options.resolve?.(request, requests.length) ?? { question: "When will You finish the permission guide?" }
      : auditing ? options.audit?.(request, requests.length) ?? auditReply(request) : reply(request, requests.length);
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
    expect(result.generation).toMatchObject({ promptVersion: CHAT_PROMPT_VERSION, model: "local:test", calls: 2,
      promptTokens: 20, outputTokens: 8, retrievalCalls: 0, retrievalMode: "full", exhaustive: true });
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
    expect(contents(model.requests[0]!).data.priorUserQuestion).toBe(history.at(-1)!.question);
    expect(contents(model.requests[0]!).instruction).toContain("earlier answers are not independent facts");
    expect(contents(model.requests[0]!).data.question).toBe("And their deadline?");
  });

  it("keeps the prior user subject explicit when an earlier answer mentioned unasked Participants", async () => {
    const { store, id, expectedRevision } = setup();
    const history = [{ question: "Who will write the permission guide?", answer: "You will write it by Thursday. Speaker 1 will review it on Friday." }];
    const model = fake(request => {
      const content = contents(request);
      expect(content.data.priorUserQuestion).toBe(history[0]!.question);
      expect(content.instruction).toContain("primarily from priorUserQuestion");
      expect(content.instruction).toContain("omit unasked tasks, Participants and deadlines");
      return { text: "You will finish the permission guide by Thursday.", sourceIds: ["0:0"], sufficient: true };
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When will they finish it?", history });
    expect(result.answer).toEqual({ text: "You will finish the permission guide by Thursday.", refs: [0], sufficient: true });
  });

  it("uses one standalone follow-up rewrite even when the entire Transcript fits", async () => {
    const { store, id, expectedRevision } = setup();
    const history = [{ question, answer: "You will write the permission guide. Speaker 1 will review it on Friday." }];
    const model = fake(request => {
      expect(contents(request).data.question).toBe("When will You finish the permission guide?");
      expect(contents(request).data.originalQuestion).toBe("When will they finish it?");
      return { ...positive, text: "You will finish the permission guide by Thursday." };
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When will they finish it?", history });
    expect(result.answer.refs).toEqual([0]);
    expect(model.requests.filter(request => "question" in (request.schema as { properties: object }).properties)).toHaveLength(1);
    expect(result.generation.calls).toBe(3);
    expect(result.generation.retrievalCalls).toBe(0);
  });

  it("bounds malformed standalone rewrites and keeps whole question context within its request budget", async () => {
    const { store, id, expectedRevision } = setup();
    let rewrites = 0;
    const model = fake(() => positive, { resolve: () => { rewrites++; return rewrites === 1 ? "not JSON" : { question: "When will You finish the permission guide?" }; } });
    const history = [{ question, answer: "Verbose previous answer ".repeat(1000) }];
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When will they finish it?", history });
    expect(rewrites).toBe(2);
    const first = contents(model.requests[0]!);
    expect(first.data.question).toBe("When will they finish it?");
    expect(first.data.priorUserQuestion).toBe(question);
    expect(first.data.history).toEqual([]);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    expect(result.generation.calls).toBe(4);
    const invalid = fake(() => positive, { resolve: () => ({ question: "" }) });
    await expect(createMeetingChat({ store, model: invalid })({ ...input(id, expectedRevision), question: "When will they finish it?", history: [{ question, answer: "You." }] })).rejects.toThrow("standalone question failed validation after three attempts");
    expect(invalid.requests).toHaveLength(3);
  });

  it.each(["And when will You finish the permission guide?", "What about the permission guide deadline?"])(
    "accepts a standalone rewrite with explicit nouns despite its follow-up prefix: %s", async rewritten => {
      const { store, id, expectedRevision } = setup();
      const model = fake(request => {
        expect(contents(request).data.question).toBe(rewritten);
        return positive;
      }, { resolve: () => ({ question: rewritten }) });
      const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "And their deadline?",
        history: [{ question, answer: "You will write the guide." }] });
      expect(result.answer.refs).toEqual([0]);
      expect(model.requests.filter(request => "question" in (request.schema as { properties: object }).properties)).toHaveLength(1);
      expect(result.generation.calls).toBe(3);
    });

  it("rejects unresolved follow-up pronouns and corrects them without a large grammar repetition bound", async () => {
    const { store, id, expectedRevision } = setup();
    let rewrites = 0;
    const model = fake(() => positive, { resolve: () => ({ question: ++rewrites === 1 ? "When will it be finished?" : "When will You finish the permission guide?" }) });
    const history = [{ question, answer: "You will write the guide." }];
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When will they finish it?", history });
    expect(rewrites).toBe(2);
    expect(contents(model.requests[1]!).instruction).toContain("Name the task or person from priorUserQuestion explicitly");
    const schema = model.requests[0]!.schema as { properties: { question: object } };
    expect(schema.properties.question).not.toHaveProperty("maxLength");
    expect(result.answer.refs).toEqual([0]);
    for (const rewritten of ["When will they finish it?", "When will it be finished?", "x".repeat(2001)]) {
      const invalid = fake(() => positive, { resolve: () => ({ question: rewritten }) });
      await expect(createMeetingChat({ store, model: invalid })({ ...input(id, expectedRevision), question: "When will they finish it?", history })).rejects.toThrow("standalone question failed validation after three attempts");
      expect(invalid.requests).toHaveLength(3);
    }
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
    expect(result.generation.calls).toBe(4);
    expect(result.generation.promptTokens).toBe(40);
    expect(contents(model.requests[1]!).instruction).toContain("Use only the original sourceIds");
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    const invalid = fake(() => ({ text: "A claim without evidence", sourceIds: [], sufficient: true }));
    await expect(createMeetingChat({ store, model: invalid })(input(id, expectedRevision))).rejects.toThrow("three attempts");
    expect(invalid.requests).toHaveLength(3);
  });

  it("audits all selected original passages, including uncited evidence, before accepting a draft", async () => {
    const { store, id, expectedRevision } = setup();
    let answers = 0;
    let audits = 0;
    const model = fake(() => { answers++; return answers === 1 ? { text: "The release date is undecided.", sourceIds: ["0:0"], sufficient: true } : positive; }, {
      audit: request => {
        audits++;
        const payload = contents(request).data as Data & { candidateAnswer: string };
        expect(payload).not.toHaveProperty("history");
        expect(payload).not.toHaveProperty("summary");
        expect(payload.sources!.map(source => source.id)).toEqual(["0:0", "1:0"]);
        expect(payload.sources![0]!.text).toBe(transcript.segments[0]!.text);
        return auditReply(request, audits > 1 ? ["0:0"] : [], audits > 1);
      },
    });
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer.text).toBe(positive.text);
    expect(answers).toBe(2);
    expect(audits).toBe(2);
    expect(contents(model.requests[2]!).instruction).toContain("do not support this answer or its relevance");
    expect(result.generation.calls).toBe(4);
  });

  it("publishes only the minimal audited citation subset without changing the answer's claims", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ ...positive, sourceIds: ["0:0", "1:0"] }), { audit: request => {
      expect(auditIds(request)).toEqual(["0:0", "1:0"]);
      expect(contents(request).instruction).toContain("collectively supporting EVERY factual claim");
      expect(contents(request).instruction).toContain("without rewriting or silently dropping claims");
      return auditReply(request, ["0:0"]);
    } });
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
    expect(result.generation.calls).toBe(2);
    expect(model.requests).toHaveLength(2);
  });

  it("repairs missing draft citations using all original context without dropping claims", async () => {
    const { store, id, expectedRevision } = setup();
    const text = "You will write the permission guide by Thursday; Speaker 1 proposed Friday for launch, but no launch date was agreed.";
    let generations = 0;
    const model = fake(() => ({ text, sufficient: true, sourceIds: ++generations === 1 ? ["0:0"] : ["0:0", "1:0"] }), {
      audit: request => {
        const ids = contents(request).data.sources!.map(source => source.id);
        // The first candidate claims two facts while citing only the first fact's passage.
        return ids.includes("1:0") ? auditReply(request, ["1:0", "0:0", "1:0"]) : auditReply(request, [], false);
      },
    });
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer).toEqual({ text, refs: [0, 1], sufficient: true });
    expect(generations).toBe(1);
    expect(result.generation.calls).toBe(2);
  });

  it("never accepts empty, unknown or mismatched quoted checks from a positive audit", async () => {
    const { store, id, expectedRevision } = setup();
    const validCheck = { speaker: "You", sourceId: "0:0", quote: transcript.segments[0]!.text, relation: "supports" };
    const invalid = [
      { supported: true, addressesQuestion: true, checks: [] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, sourceId: "unknown:0" }] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, sourceId: "1:0" }] },
      { supported: true },
      { supported: true, addressesQuestion: true, checks: null },
      { supported: true, addressesQuestion: true, checks: "0:0" },
      { supported: true, addressesQuestion: true, checks: [0] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, quote: "A made-up deadline on Friday." }] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, speaker: "Speaker 1" }] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, relation: "agrees" }] },
      { supported: true, addressesQuestion: true, checks: [{ ...validCheck, quote: "" }] },
    ];
    for (const value of invalid) {
      const model = fake(() => positive, { audit: request => {
        expect(auditIds(request)).toEqual(["0:0", "1:0"]);
        return value;
      } });
      await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("three attempts");
      expect(model.requests.filter(isAnswer)).toHaveLength(3);
      expect(model.requests).toHaveLength(6);
    }
  });

  it("rejects a pooled stance when a named speaker's exact words contradict it, even if the audit boolean says true", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "Speaker 1", text: "I prefer keeping audio by default." },
      { start: 5, end: 10, speaker: "Speaker 2", text: "I disagree. Audio should be deleted after transcription." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    let answers = 0;
    const model = fake(() => ({ text: ++answers === 1 ? "Speaker 1 and Speaker 2 wanted to retain audio." : "Speaker 1 wanted to retain audio.",
      sourceIds: ["0:0"], sufficient: true }), { audit: request => {
      const payload = contents(request).data as Data & { candidateAnswer: string };
      const serialized = request.messages.at(-1)!.content;
      expect(serialized.indexOf('"sources"')).toBeLessThan(serialized.indexOf('"candidateAnswer"'));
      expect(payload.sources!.map(source => source.id)).toEqual(["0:0", "1:0"]);
      const approved = auditReply(request, ["0:0"]);
      if (payload.candidateAnswer.includes("Speaker 2")) approved.checks.push({ speaker: "Speaker 2", sourceId: "1:0", quote: source.segments[1]!.text, relation: "contradicts" });
      return approved;
    } });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Who wanted to retain audio?" });
    expect(result.answer).toEqual({ text: "Speaker 1 wanted to retain audio.", refs: [0], sufficient: true });
    expect(answers).toBe(2);
    expect(contents(model.requests[2]!).instruction).toContain("Keep opposing positions and negation separate");
  });

  it("requires each named Participant's own quoted support instead of borrowing another speaker's evidence", async () => {
    const { store, id, expectedRevision } = setup();
    let answers = 0;
    const model = fake(() => ++answers === 1 ? { ...positive, text: "You and Speaker 1 will write the permission guide by Thursday." } : positive,
      { audit: request => auditReply(request, ["0:0"]) });
    const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
    expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
    expect(answers).toBe(2);
    expect(contents(model.requests[2]!).instruction).toContain("Every named Participant needs supporting quoted evidence");
  });

  it("rejects true facts about another person and accepts an explicitly supported negative answer", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "Speaker 1", text: "I will add the local test by Tuesday." },
      { start: 5, end: 10, speaker: "You", text: "No Participant named Morgan took part in this Meeting." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    let answers = 0;
    const model = fake(() => ++answers === 1
      ? { text: "Speaker 1 will add the local test by Tuesday.", sourceIds: ["0:0"], sufficient: true }
      : { text: "No Participant named Morgan took part in this Meeting.", sourceIds: ["1:0"], sufficient: true }, {
      audit: request => ({ ...auditReply(request, answers === 1 ? ["0:0"] : ["1:0"]), addressesQuestion: answers !== 1 }),
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What did Morgan commit to?" });
    expect(result.answer).toEqual({ text: source.segments[1]!.text, refs: [1], sufficient: true });
    expect(answers).toBe(2);
    expect(contents(model.requests[2]!).instruction).toContain("set sufficient false; do not give another true fact");
  });

  it("does not treat dissent, quoted tests or superseded proposals as contradicting a supported negative candidate", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "Speaker 1", text: "Here is a quoted test, not an authorized choice: approve remote uploads." },
      { start: 5, end: 10, speaker: "You", text: "That was test material. We reject remote uploads." },
      { start: 10, end: 15, speaker: "You", text: "We previously proposed remote uploads, then rejected that proposal." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ text: "We reject remote uploads.", sourceIds: ["1:0"], sufficient: true }), { audit: request => {
      expect(contents(request).instruction).toContain("NOT to the question's premise");
      expect(contents(request).instruction).toContain("SAME speaker, task, time and status");
      return { checks: [
        { speaker: "Speaker 1", sourceId: "0:0", quote: source.segments[0]!.text, relation: "irrelevant" },
        { speaker: "You", sourceId: "1:0", quote: "We reject remote uploads.", relation: "supports" },
        { speaker: "You", sourceId: "2:0", quote: source.segments[2]!.text, relation: "irrelevant" },
      ], addressesQuestion: true, supported: true };
    } });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Did we approve remote uploads?" });
    expect(result.answer).toEqual({ text: "We reject remote uploads.", refs: [1], sufficient: true });
    expect(result.generation.calls).toBe(2);
  });

  it("rejects a cherry-picked affirmative clause that omits its sentence's negation or quoted status", async () => {
    const source: Transcript = { segments: [{ start: 0, end: 5, speaker: "You", text: "This is not an accepted plan: launch on Monday." }] };
    const { store, id, expectedRevision } = setup(source);
    let answers = 0;
    const model = fake(() => ({ text: ++answers === 1 ? "Monday is accepted." : "The Monday plan was not accepted.", sourceIds: ["0:0"], sufficient: true }), {
      audit: () => ({ checks: [{ speaker: "You", sourceId: "0:0", quote: answers === 1 ? "launch on Monday." : source.segments[0]!.text.slice(0, -1), relation: "supports" }], addressesQuestion: true, supported: true }),
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "Was the Monday plan accepted?" });
    expect(result.answer).toEqual({ text: "The Monday plan was not accepted.", refs: [0], sufficient: true });
    expect(answers).toBe(2);
    expect(contents(model.requests[2]!).instruction).toContain("complete source sentence with its qualifiers and negation");
  });

  it("never accepts a weekday as the requested calendar date and can correct to an explicitly supported missing date", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "You", text: "Friday is the agreed launch day." },
      { start: 5, end: 10, speaker: "Speaker 1", text: "We did not set a calendar date for Friday." },
    ] };
    const { store, id, expectedRevision } = setup(source);
    let answers = 0;
    const model = fake(() => ({ text: ++answers === 1 ? "Friday" : "We did not set a calendar date for Friday.", sourceIds: ["1:0"], sufficient: true }),
      { audit: request => auditReply(request, ["1:0"]) });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What calendar date is the launch?" });
    expect(result.answer).toEqual({ text: source.segments[1]!.text, refs: [1], sufficient: true });
    expect(result.generation.calls).toBe(3);
    expect(contents(model.requests[1]!).instruction).toContain("A weekday alone is not the requested calendar date");
    const invalid = fake(() => ({ text: "Friday", sourceIds: ["0:0"], sufficient: true }));
    await expect(createMeetingChat({ store, model: invalid })({ ...input(id, expectedRevision), question: "What calendar date is the launch?" })).rejects.toThrow("three attempts");
    expect(invalid.requests).toHaveLength(3);
    expect(invalid.requests.every(isAnswer)).toBe(true);
    const weekday = fake(() => ({ text: "Friday", sourceIds: ["0:0"], sufficient: true }));
    expect((await createMeetingChat({ store, model: weekday })({ ...input(id, expectedRevision), question: "Which weekday is the launch?" })).answer.text).toBe("Friday");
  });

  it.each(["30 October 2026", "October 30, 2026", "2026-10-30", "30/10/2026"])("accepts a sourced calendar date in English or numeric notation: %s", async date => {
    const source: Transcript = { segments: [{ start: 0, end: 5, speaker: "You", text: `The launch date is ${date}.` }] };
    const { store, id, expectedRevision } = setup(source);
    const model = fake(() => ({ text: date, sourceIds: ["0:0"], sufficient: true }));
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "What calendar date is the launch?" });
    expect(result.answer).toEqual({ text: date, refs: [0], sufficient: true });
    expect(result.generation.calls).toBe(2);
  });

  it("keeps unsupported answers failed after three generation-and-audit attempts", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => positive, { audit: request => auditReply(request, [], false) });
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("three attempts");
    expect(model.requests.filter(isAnswer)).toHaveLength(3);
    expect(model.requests.filter(request => "supported" in (request.schema as { properties: object }).properties)).toHaveLength(3);
  });

  it("preserves prior user intent in a follow-up audit without sending previous assistant facts", async () => {
    const { store, id, expectedRevision } = setup();
    const history = [{ question, answer: "PRIVATE EARLIER ASSISTANT DETOUR" }];
    const model = fake(() => positive, { audit: request => {
      const payload = contents(request).data;
      expect(payload.originalQuestion).toBe("When will they finish it?");
      expect(payload.question).toBe("When will You finish the permission guide?");
      expect(payload.priorUserQuestion).toBe(question);
      expect(JSON.stringify(request)).not.toContain("PRIVATE EARLIER ASSISTANT DETOUR");
      return auditReply(request, payload.sources!.map(source => source.id));
    } });
    await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: "When will they finish it?", history });
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("rejects oversized answer prose with bounded corrective retries before auditing or publishing it", async () => {
    const { store, id, expectedRevision } = setup();
    const model = fake(() => ({ ...positive, text: "Supported but oversized prose ".repeat(1000) }));
    await expect(createMeetingChat({ store, model })(input(id, expectedRevision))).rejects.toThrow("concise enough for evidence verification");
    expect(model.requests).toHaveLength(3);
    expect(model.requests.every(isAnswer)).toBe(true);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("accounts for Unicode and nested escape expansion in the reserved audit text limit", async () => {
    const { store, id, expectedRevision } = setup();
    for (const text of ["😀".repeat(500), "Claim " + String.fromCharCode(92, 10).repeat(400)]) {
      expect(text.length).toBeLessThan(2000);
      const model = fake((_request, call) => call === 1 ? { ...positive, text } : positive);
      const result = await createMeetingChat({ store, model })(input(id, expectedRevision));
      expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
      expect(result.generation.calls).toBe(3);
      expect(contents(model.requests[1]!).instruction).toContain("concise enough for evidence verification");
      expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
    }
  });

  it("narrows evidence before generating when a long question and full context would leave no audit room", async () => {
    const source: Transcript = { segments: [
      { start: 0, end: 5, speaker: "You", text: transcript.segments[0]!.text + " Supporting context about the existing local task. ".repeat(12) },
      { start: 5, end: 10, speaker: "Speaker 1", text: "Coffee supplies are in the kitchen. " + " Unrelated office furniture and supplies were discussed. ".repeat(11) },
      { start: 10, end: 15, speaker: "Speaker 1", text: "Parking is on the east side. " + " Unrelated travel arrangements and signs were discussed. ".repeat(11) },
    ] };
    const { store, id, expectedRevision } = setup(source);
    const longQuestion = question + " Please consider the stated permission guide task. ".repeat(20);
    const model = fake(request => {
      const data = contents(request).data;
      if (isAnswer(request)) {
        expect(data.sources!.map(source => source.ref)).toEqual([0]);
        expect(data.question).toBe(longQuestion);
        return positive;
      }
      const selected = data.sources!.filter(source => source.ref === 0);
      return { sourceIds: selected.map(source => source.id), sufficient: selected.length > 0 };
    });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: longQuestion });
    expect(isAnswer(model.requests[0]!)).toBe(false);
    expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
    expect(result.generation.retrievalCalls).toBeGreaterThan(0);
    expect(model.requests.every(request => requestBytes(request) <= 5500)).toBe(true);
  });

  it("propagates audit connection failures and cancellation instead of publishing a candidate", async () => {
    const { store, id, expectedRevision } = setup();
    const failed = fake(() => positive, { audit: () => { throw new Error("Audit model is unavailable"); } });
    await expect(createMeetingChat({ store, model: failed })(input(id, expectedRevision))).rejects.toThrow("Audit model is unavailable");
    const controller = new AbortController();
    const cancelled = fake(() => positive, { audit: request => { controller.abort(); return auditReply(request, ["0:0"]); } });
    await expect(createMeetingChat({ store, model: cancelled })({ ...input(id, expectedRevision), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
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
      const matched = data.sources!.filter(source => source.ref === 4);
      // A targeted selector may overestimate partial topic context; the answer must still trigger the full-scan fallback.
      const selected = matched.length ? matched : data.sources!.slice(0, 1);
      return { sourceIds: selected.map(source => source.id), sufficient: selected.length > 0 };
    });
    const stages: string[] = [];
    const result = await createMeetingChat({ store: scoped, model })({ ...input(id, expectedRevision), question: "Who will write the launch guide?", onStage: stage => stages.push(stage) });
    expect(answers).toBe(2);
    expect(stages.filter(stage => stage === "retrieving")).toHaveLength(2);
    expect(result.answer).toEqual({ text: "You will write the launch guide by Wednesday.", refs: [4], sufficient: true });
    expect(result.generation).toMatchObject({ retrievalMode: "scan", exhaustive: true });
    expect(result.generation.retrievalCalls).toBe(model.requests.filter(request => !isAnswer(request) && !("supported" in (request.schema as { properties: object }).properties)).length);
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

  it("drops an unrelated long prior question instead of poisoning an independent question's audit budget", async () => {
    const { store, id, expectedRevision } = setup();
    const independent = question + " Please focus on the permission guide. ".repeat(25);
    const unrelated = "Unrelated previous subject ".repeat(80).slice(0, 1989);
    const model = fake(request => {
      expect(contents(request).data.question).toBe(independent);
      expect(contents(request).data.history).toEqual([]);
      expect(contents(request).data).not.toHaveProperty("priorUserQuestion");
      return positive;
    }, { audit: request => {
      expect(contents(request).data).not.toHaveProperty("priorUserQuestion");
      expect(JSON.stringify(request)).not.toContain(unrelated);
      return auditReply(request, ["0:0"]);
    } });
    const result = await createMeetingChat({ store, model })({ ...input(id, expectedRevision), question: independent,
      history: [{ question: unrelated, answer: "Unrelated previous answer ".repeat(100) }] });
    expect(result.answer).toEqual({ text: positive.text, refs: [0], sufficient: true });
    expect(result.generation.calls).toBe(2);
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
