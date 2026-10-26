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
import { createGroundedSummariser } from "../pipeline/grounded-summariser.js";
import { OllamaClient, DEFAULT_SUMMARY_MODEL } from "../pipeline/ollama.js";
import type { LanguageModel, TextModel } from "../pipeline/language-model.js";
import { evaluateFixture, validateFixture } from "./runner.js";
import { evaluationMetadata } from "./metadata.js";

const [mode, source, output] = process.argv.slice(2);
if (!source || !output || !["baseline", "current", "chat", "summary", "private-baseline", "private-current", "private-chat", "private-summary"].includes(mode ?? "")) throw new Error("Usage: eval:ai <baseline|current|chat|summary|private-baseline|private-current|private-chat|private-summary> <fixtures-dir|private-manifest.json> <results.json>");
const privateRun = mode!.startsWith("private-");
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
const modelName = process.env.AI_MODEL ?? DEFAULT_SUMMARY_MODEL;
const metadata = { ...await evaluationMetadata(modelName, implementation), ...(implementation === "current" ? { chatPromptVersion: CHAT_PROMPT_VERSION } : {}) };
const client = new OllamaClient({ model: modelName });
const baseline = new BaselineOllamaClient({ model: modelName });
let calls = 0;
const model: LanguageModel & TextModel = {
  generate: request => { calls++; return baseline.generate(request); },
  complete: request => { calls++; console.log(`Local model request ${calls}`); return client.complete(request); },
};
const summarise = implementation === "baseline" ? createBaselineSummariser({ model }) : createGroundedSummariser({ model });
const store = openStore(":memory:");
const meetingIds = new WeakMap<Transcript, number>();
const chat = createMeetingChat({ store, model, modelName });
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
  await writeFile(destination, JSON.stringify({ metadata, runs }, null, 2) + "\n");
  console.log(`${fixture.id}: ${runs.at(-1)?.error ? "failed" : "generated; human review pending"}`);
}
} finally { store.close(); }
