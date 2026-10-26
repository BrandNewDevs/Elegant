import type { Summary, Transcript } from "../pipeline/pipeline.js";

export interface EvaluationFixture {
  id: string;
  split: "tuning" | "reserved";
  synthetic: boolean;
  transcript: Transcript;
  points: { id: string; text: string; speaker: string; refs: number[]; critical: boolean }[];
  questions: { id: string; question: string; answer: string | null; refs: number[]; followUpTo?: string; critical: boolean }[];
}
export interface EvaluationAnswer { text: string; refs: number[]; sufficient: boolean; revision?: string; generation?: import("../shared/meeting-chat.js").ChatGeneration }
export interface EvaluationPipeline {
  summarise?(transcript: Transcript): Promise<Summary>;
  answer?(transcript: Transcript, question: string, history: { question: string; answer: EvaluationAnswer }[]): Promise<EvaluationAnswer>;
}

/** Evaluation crosses the same Summary/chat interfaces as the app; it never supplies expected answers to the model. */
export async function evaluateFixture(fixture: EvaluationFixture, pipeline: EvaluationPipeline, callCount: () => number) {
  const started = performance.now();
  const initialCalls = callCount();
  let summary: Summary | undefined;
  let error: string | undefined;
  try { if (pipeline.summarise) summary = await pipeline.summarise(fixture.transcript); }
  catch (problem) { error = problem instanceof Error ? problem.message : String(problem); }
  const summaryElapsedMs = performance.now() - started;
  const summaryCalls = callCount() - initialCalls;
  const chat: { questionId: string; answer?: EvaluationAnswer; error?: string; skipped?: string; elapsedMs?: number; calls?: number }[] = [];
  const completed = new Map<string, { question: string; answer: EvaluationAnswer }[]>();
  for (const question of fixture.questions) {
    if (!pipeline.answer) { chat.push({ questionId: question.id, skipped: "Chat was not selected for this evaluation" }); continue; }
    const history = question.followUpTo ? completed.get(question.followUpTo) ?? [] : [];
    const queryStarted = performance.now(), beforeQuery = callCount();
    try {
      const answer = await pipeline.answer(fixture.transcript, question.question, history);
      chat.push({ questionId: question.id, answer, elapsedMs: performance.now() - queryStarted, calls: callCount() - beforeQuery });
      completed.set(question.id, [...history, { question: question.question, answer }]);
    } catch (problem) { chat.push({ questionId: question.id, error: problem instanceof Error ? problem.message : String(problem), elapsedMs: performance.now() - queryStarted, calls: callCount() - beforeQuery }); }
  }
  return { id: fixture.id, split: fixture.split, synthetic: fixture.synthetic, summary, error, chat, summarySkipped: !pipeline.summarise,
    elapsedMs: performance.now() - started, calls: callCount() - initialCalls, summaryElapsedMs, summaryCalls,
    peakRssKiB: process.resourceUsage().maxRSS };
}

/** Reject fixture mistakes before spending a model call. Ordinals match the production Transcript order. */
export function validateFixture(value: unknown): EvaluationFixture {
  const fixture = value as EvaluationFixture;
  if (!fixture || typeof fixture.id !== "string" || !["tuning", "reserved"].includes(fixture.split) || typeof fixture.synthetic !== "boolean"
      || !Array.isArray(fixture.transcript?.segments) || !Array.isArray(fixture.points) || !Array.isArray(fixture.questions)) throw new Error("Invalid evaluation fixture");
  const nonempty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;
  let previousStart = -Infinity;
  fixture.transcript.segments.forEach(s => {
    if (!s || typeof s.text !== "string" || !nonempty(s.speaker) || !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.start < previousStart || s.end < s.start) throw new Error(`Invalid segment in ${fixture.id}`);
    previousStart = s.start;
  });
  const validRefs = (refs: number[]) => Array.isArray(refs) && refs.every(ref => Number.isInteger(ref) && ref >= 0 && ref < fixture.transcript.segments.length);
  const pointIds = new Set<string>();
  for (const p of fixture.points) {
    if (!nonempty(p.id) || pointIds.has(p.id) || !nonempty(p.text) || typeof p.critical !== "boolean" || !validRefs(p.refs) || !p.refs.length || !p.refs.some(i => fixture.transcript.segments[i]?.speaker === p.speaker)) throw new Error(`Invalid expected point in ${fixture.id}`);
    pointIds.add(p.id);
  }
  const questionIds = new Set<string>();
  for (const q of fixture.questions) {
    if (!nonempty(q.id) || questionIds.has(q.id) || !nonempty(q.question) || typeof q.critical !== "boolean" || !(q.answer === null || typeof q.answer === "string") || !validRefs(q.refs) || (q.followUpTo && !questionIds.has(q.followUpTo))) throw new Error(`Invalid expected question in ${fixture.id}`);
    questionIds.add(q.id);
  }
  return fixture;
}
