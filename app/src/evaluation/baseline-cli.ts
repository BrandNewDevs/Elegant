import { readFile, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { createBaselineSummariser } from "./baseline.js";
import { OllamaClient, DEFAULT_SUMMARY_MODEL, DEFAULT_OLLAMA_URL } from "../pipeline/ollama.js";
import type { LanguageModel } from "../pipeline/language-model.js";
import type { Transcript } from "../pipeline/pipeline.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error("Usage: eval:baseline <synthetic-transcript.json> <result.json>");
const transcript = JSON.parse(await readFile(input, "utf8")) as Transcript;
if (!Array.isArray(transcript.segments)) throw new Error("Expected a Transcript with segments");
const model = process.env.AI_MODEL ?? DEFAULT_SUMMARY_MODEL;
const baseUrl = DEFAULT_OLLAMA_URL;
async function localJson(path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Ollama metadata: ${response.status}`);
  return response.json();
}
const tags = await localJson("/api/tags") as { models: { name: string; digest: string; details: unknown }[] };
const installed = tags.models.find(m => m.name === model);
if (!installed) throw new Error(`Model ${model} is not installed; set AI_MODEL to an installed tag`);
const client = new OllamaClient({ model });
let calls = 0;
const counted: LanguageModel = { generate: request => { calls++; return client.generate(request); } };
const started = performance.now();
const summary = await createBaselineSummariser({ model: counted })(transcript);
let gpu = "unavailable";
try { gpu = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8" }).trim(); } catch { /* Apple devices do not have nvidia-smi. */ }
const result = {
  implementation: "baseline-1ee9d82", promptVersion: "baseline-v1", model: installed,
  ollama: await localJson("/api/version"), settings: { numCtx: 8192, temperature: 0, maxChunkChars: 12000 },
  hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), gpu },
  elapsedMs: performance.now() - started, calls, processPeakRssKiB: process.resourceUsage().maxRSS,
  memoryScope: "Node process only; model and engine memory require separate device observation",
  summary,
};
await writeFile(output, JSON.stringify(result, null, 2) + "\n");
console.log(`Saved ${calls} model call(s) to ${output}`);
