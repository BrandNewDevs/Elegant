import { readFile, readdir, writeFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isOutside, privateOutputPath } from "./private-path.js";
import { fileURLToPath } from "node:url";
import { createMeetingChat, CHAT_PROMPT_VERSION } from "../pipeline/meeting-chat.js";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { Transcript } from "../pipeline/pipeline.js";
import { openStore } from "../store/store.js";
import { BaselineOllamaClient } from "./baseline-model.js";
import { createBaselineSummariser } from "./baseline.js";
import { createReadableSummariser } from "../pipeline/readable-summariser.js";
import { OllamaClient, DEFAULT_SUMMARY_MODEL } from "../pipeline/ollama.js";
import type { LanguageModel, TextModel } from "../pipeline/language-model.js";
import { evaluateFixture, validateFixture } from "./runner.js";
import { evaluationMetadata } from "./metadata.js";
import { requestBytes } from "../pipeline/model-request.js";
import { EVIDENCE_PROMPT_VERSION } from "../pipeline/meeting-evidence.js";
import { GeminiClient, DEFAULT_GEMINI_MODEL } from "../pipeline/gemini.js";
import { createGeminiSummariser, createGeminiChat, GEMINI_CHAT_VERSION } from "../pipeline/gemini-pipeline.js";

const [mode, source, output] = process.argv.slice(2);
if (!source || !output || !["baseline", "current", "chat", "summary", "private-baseline", "private-current", "private-chat", "private-summary"].includes(mode ?? "")) throw new Error("Usage: eval:ai <baseline|current|chat|summary|private-baseline|private-current|private-chat|private-summary> <fixtures-dir|private-manifest.json> <results.json>");
const privateRun = mode!.startsWith("private-");
const traceEnabled = process.env.AI_SYNTHETIC_TRACE === "1";
if (traceEnabled && (privateRun || mode!.endsWith("baseline"))) throw new Error("Synthetic tracing is available only for current synthetic evaluation; private content is never traced");
const provider = process.env.AI_PROVIDER ?? "ollama";
if (provider !== "ollama" && provider !== "gemini") throw new Error("AI_PROVIDER must be ollama or gemini");
if (provider === "gemini" && mode!.endsWith("baseline")) throw new Error("The frozen baseline is Ollama-only; use summary, chat or current for Gemini");
if (provider === "gemini" && privateRun && process.env.AI_ALLOW_CLOUD_PRIVATE !== "1") throw new Error("Private Gemini evaluation sends Transcript content to Google. Explicitly set AI_ALLOW_CLOUD_PRIVATE=1 only with permission to share it.");
if (provider === "gemini" && !process.env.GEMINI_API_KEY?.trim()) throw new Error("Set GEMINI_API_KEY for Gemini evaluation; the key is never written to reports");
const root = await realpath(fileURLToPath(new URL("../../../", import.meta.url)));
const outside = (path: string) => isOutside(root, path);
let destination = resolve(output);
let paths: string[];
if (privateRun) {
  const manifest = JSON.parse(await readFile(source, "utf8")) as { examples: { path: string | null; status: string }[] };
  paths = manifest.examples.filter(e => e.path !== null).map(e => resolve(e.path!));
  if (!paths.length) throw new Error("No private fixtures supplied; real-data evaluation remains pending");
  destination = await privateOutputPath(root, output);
} else paths = (await readdir(source)).filter(p => p.endsWith(".json")).sort().map(p => resolve(source, p));
const fixtures = [];
for (const path of paths) {
  const canonical = await realpath(path);
  const fixture = validateFixture(JSON.parse(await readFile(canonical, "utf8")));
  if (fixture.synthetic === privateRun) throw new Error(`Expected ${privateRun ? "private" : "synthetic"} fixture: ${path}`);
  if (!fixture.synthetic && !outside(canonical)) throw new Error("Real Transcripts must be kept outside the repository");
  fixtures.push(fixture);
}
const split = process.env.AI_SPLIT;
if (split && split !== "tuning" && split !== "reserved") throw new Error("AI_SPLIT must be tuning or reserved");
const selected = split ? fixtures.filter(fixture => fixture.split === split) : fixtures;
if (!selected.length) throw new Error("No fixtures found for this split");
const implementation = mode!.endsWith("baseline") ? "baseline" : "current";
const deadlineOverride = process.env.AI_SUMMARY_DEADLINE_MS;
const summaryDeadlineMs = deadlineOverride === undefined ? 15 * 60_000 : Number(deadlineOverride);
if (!Number.isSafeInteger(summaryDeadlineMs) || summaryDeadlineMs < 1 || summaryDeadlineMs > 60 * 60_000) {
  throw new Error("AI_SUMMARY_DEADLINE_MS must be an integer from 1 to 3600000; it changes evaluation only");
}
const modelName = process.env.AI_MODEL ?? (provider === "gemini" ? DEFAULT_GEMINI_MODEL : DEFAULT_SUMMARY_MODEL);
const metadata = { ...await evaluationMetadata(modelName, implementation, provider), ...(implementation === "current" ? {
  summaryDeadlineMs, evaluationDeadlineOverride: deadlineOverride !== undefined,
  chatPromptVersion: provider === "gemini" ? GEMINI_CHAT_VERSION : CHAT_PROMPT_VERSION, evidencePromptVersion: provider === "gemini" ? "gemini-original-evidence-v1" : EVIDENCE_PROMPT_VERSION,
} : {}) };
const client = provider === "gemini" ? new GeminiClient({ model: modelName, apiKey: process.env.GEMINI_API_KEY! }) : new OllamaClient({ model: modelName });
const baseline = new BaselineOllamaClient({ model: modelName });
let calls = 0;
const requests: { call: number; bytes: number; promptTokens?: number; outputTokens?: number; elapsedMs?: number; failed?: boolean }[] = [];
const traces: object[] = [];
const model: LanguageModel & TextModel = {
  generate: request => { calls++; return baseline.generate(request); },
  complete: async request => {
    const observation: (typeof requests)[number] = { call: ++calls, bytes: requestBytes(request) };
    requests.push(observation);
    console.log(`${provider === "gemini" ? "Gemini" : "Local model"} request ${calls}`);
    try {
      const result = await client.complete(request);
      if (traceEnabled) traces.push({ call: observation.call, messages: request.messages, schema: request.schema, response: result.text });
      Object.assign(observation, { promptTokens: result.metadata.promptTokens, outputTokens: result.metadata.outputTokens, elapsedMs: result.metadata.elapsedMs });
      return result;
    } catch (error) { observation.failed = true; throw error; }
  },
};
const summarise = implementation === "baseline" ? createBaselineSummariser({ model }) : provider === "gemini" ? createGeminiSummariser({ model, deadlineMs: summaryDeadlineMs }) : createReadableSummariser({ model, deadlineMs: summaryDeadlineMs });
const store = openStore(":memory:");
const meetingIds = new WeakMap<Transcript, number>();
const chat = provider === "gemini" ? createGeminiChat({ store, model }) : createMeetingChat({ store, model, modelName });
const pipeline = { ...(mode!.endsWith("chat") ? {} : { summarise }), ...(implementation === "current" && !mode!.endsWith("summary") ? { answer: async (transcript: Transcript, question: string,
  history: { question: string; answer: { text: string } }[]) => {
  let meetingId = meetingIds.get(transcript);
  if (!meetingId) {
    meetingId = store.createMeeting({ app: "Evaluation", startedAt: new Date().toISOString() });
    store.saveTranscript(meetingId, transcript);
    store.setMeetingState(meetingId, "done");
    meetingIds.set(transcript, meetingId);
  }
  const result = await chat({ meetingId, question, history: history.map(pair => ({ question: pair.question, answer: pair.answer.text })),
    expectedRevision: transcriptRevision(transcript) });
  return { ...result.answer, revision: result.revision, generation: result.generation };
} } : {}) };
const runs = [];
try {
for (const fixture of selected) {
  runs.push(await evaluateFixture(fixture, pipeline, () => calls));
  // Keep results even if a later fixture fails or the process is interrupted. Content stays at the selected local path.
  await writeFile(destination, JSON.stringify({ metadata, runs, requests,
    ...(traceEnabled ? { traceScope: "Explicit synthetic-only debug trace; never enabled for private modes", traces } : {}) }, null, 2) + "\n");
  console.log(`${fixture.id}: ${runs.at(-1)?.error ? "failed" : "generated; human review pending"}`);
}
} finally { store.close(); }
