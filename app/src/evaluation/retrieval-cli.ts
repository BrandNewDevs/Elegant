import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMeetingEvidence, EVIDENCE_PROMPT_VERSION } from "../pipeline/meeting-evidence.js";
import { OllamaClient, DEFAULT_SUMMARY_MODEL } from "../pipeline/ollama.js";
import type { TextModel } from "../pipeline/language-model.js";
import { openStore } from "../store/store.js";
import { validateFixture } from "./runner.js";
import { evaluationMetadata } from "./metadata.js";

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error("Usage: eval:retrieval <synthetic-fixtures-directory> <result.json>");
const split = process.env.AI_SPLIT;
if (split && split !== "tuning" && split !== "reserved") throw new Error("AI_SPLIT must be tuning or reserved");
const fixtures = [];
for (const name of (await readdir(directory)).filter(name => name.endsWith(".json")).sort()) {
  const fixture = validateFixture(JSON.parse(await readFile(resolve(directory, name), "utf8")));
  if (!fixture.synthetic) throw new Error("This standalone retrieval command accepts synthetic fixtures only. Use private-current for private end-to-end evaluation.");
  if (!split || fixture.split === split) fixtures.push(fixture);
}
if (!fixtures.length) throw new Error("No fixtures selected");
const modelName = process.env.AI_MODEL ?? DEFAULT_SUMMARY_MODEL;
const metadata = { ...await evaluationMetadata(modelName, "retrieval"), promptVersion: EVIDENCE_PROMPT_VERSION,
  scope: "Source reference recall only; presence of a reference does not establish answer correctness" };
const client = new OllamaClient({ model: modelName });
let calls = 0;
const model: TextModel = { complete: request => { calls++; console.log(`Local retrieval request ${calls}`); return client.complete(request); } };
const store = openStore(":memory:");
const retrieve = createMeetingEvidence({ store, model });
const runs = [];
try {
  for (const fixture of fixtures) {
    const meetingId = store.createMeeting({ app: "Synthetic evaluation", startedAt: new Date().toISOString() });
    store.saveTranscript(meetingId, fixture.transcript);
    store.setMeetingState(meetingId, "done");
    const queries = [];
    for (const question of fixture.questions) {
      const previous = question.followUpTo ? fixture.questions.find(q => q.id === question.followUpTo) : undefined;
      const history = previous ? [{ question: previous.question, answer: "" }] : [];
      // Expected answers are never supplied to retrieval or query rewriting.
      const started = performance.now(), before = calls;
      try {
        const result = await retrieve({ meetingId, question: question.question, history });
        const refs = [...new Set(result.sources.map(source => source.ref))].sort((a, b) => a - b);
        queries.push({ questionId: question.id, mode: result.mode, exhaustive: result.exhaustive, sufficient: result.sufficient,
          refs, expectedRefs: question.refs, sourceRecall: question.refs.length ? question.refs.filter(ref => refs.includes(ref)).length / question.refs.length : null,
          reason: result.reason, elapsedMs: performance.now() - started, calls: calls - before });
      } catch (error) {
        queries.push({ questionId: question.id, error: error instanceof Error ? error.message : "Retrieval failed", elapsedMs: performance.now() - started, calls: calls - before });
      }
      console.log(`${fixture.id}/${question.id}: retrieval recorded`);
    }
    runs.push({ id: fixture.id, split: fixture.split, synthetic: true, queries });
    await writeFile(output, JSON.stringify({ metadata, runs }, null, 2) + "\n");
  }
} finally { store.close(); }
