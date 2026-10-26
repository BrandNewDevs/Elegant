import { readFile, readdir, writeFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isOutside, privateOutputPath } from "./private-path.js";
import { fileURLToPath } from "node:url";
import { BaselineOllamaClient } from "./baseline-model.js";
import { createBaselineSummariser } from "./baseline.js";
import { createSummariser } from "../pipeline/summariser.js";
import { OllamaClient, DEFAULT_SUMMARY_MODEL } from "../pipeline/ollama.js";
import type { LanguageModel } from "../pipeline/language-model.js";
import { evaluateFixture, validateFixture } from "./runner.js";
import { evaluationMetadata } from "./metadata.js";

const [mode, source, output] = process.argv.slice(2);
if (!source || !output || !["baseline", "current", "private-baseline", "private-current"].includes(mode ?? "")) throw new Error("Usage: eval:ai <baseline|current|private-baseline|private-current> <fixtures-dir|private-manifest.json> <results.json>");
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
const metadata = await evaluationMetadata(modelName, implementation);
const client = implementation === "baseline" ? new BaselineOllamaClient({ model: modelName }) : new OllamaClient({ model: modelName });
let calls = 0;
const model: LanguageModel = { generate: request => { calls++; return client.generate(request); } };
const summarise = (implementation === "baseline" ? createBaselineSummariser : createSummariser)({ model });
const runs = [];
for (const fixture of selected) {
  runs.push(await evaluateFixture(fixture, { summarise }, () => calls));
  // Keep results even if a later fixture fails or the process is interrupted. Content stays at the selected local path.
  await writeFile(destination, JSON.stringify({ metadata, runs }, null, 2) + "\n");
  console.log(`${fixture.id}: ${runs.at(-1)?.error ? "failed" : "generated; human review pending"}`);
}
