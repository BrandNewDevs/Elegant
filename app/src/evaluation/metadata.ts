import { cpus, platform, release, totalmem } from "node:os";
import { execFileSync } from "node:child_process";
import { SUMMARY_PROMPT_VERSION } from "../pipeline/grounded-summariser.js";
import { DEFAULT_OLLAMA_URL } from "../pipeline/ollama.js";

export async function evaluationMetadata(model: string, implementation: string) {
  const json = async (path: string) => {
    const response = await fetch(DEFAULT_OLLAMA_URL + path, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Ollama metadata request failed (${response.status})`);
    return response.json();
  };
  const tags = await json("/api/tags") as { models: { name: string; digest: string; details: unknown }[] };
  const installed = tags.models.find(m => m.name === model);
  if (!installed) throw new Error(`Model ${model} is not installed. Set AI_MODEL to an installed tag.`);
  let gpu = "unavailable";
  try { gpu = execFileSync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], { encoding: "utf8" }).trim(); } catch { /* Not an NVIDIA device. */ }
  return { recordedAt: new Date().toISOString(), implementation, model: installed, ollama: await json("/api/version"),
    hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryBytes: totalmem(), gpu },
    settings: { numCtx: 8192, temperature: 0, ...(implementation === "baseline" ? { maxChunkChars: 12000 } : { maxInputBytes: 5500, maxOutputTokens: 2048 }) }, promptVersion: implementation === "baseline" ? "baseline-v1" : SUMMARY_PROMPT_VERSION,
    memoryScope: "Node peak RSS only. Ollama, Swift, peak total memory and swap need external observation.",
    runCondition: process.env.AI_RUN_CONDITION ?? "uncontrolled" };
}
