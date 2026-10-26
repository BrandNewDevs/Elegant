import type { LanguageModel } from "./language-model.js";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  /** Context window requested from Ollama, whose own default (4096 tokens) is too small for a long chunk. */
  numCtx?: number;
  timeoutMs?: number;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_SUMMARY_MODEL = "gemma3:4b";

/** A LanguageModel served by a local Ollama. Failures say what to do about them, since they end up on a failed Meeting. */
export class OllamaClient implements LanguageModel {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;

  constructor({ baseUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_SUMMARY_MODEL, numCtx = 8192, timeoutMs = 5 * 60_000 }: OllamaOptions = {}) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.numCtx = numCtx;
    this.timeoutMs = timeoutMs;
  }

  async generate({ prompt, schema }: { prompt: string; schema: object }): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          format: schema,
          options: { num_ctx: this.numCtx, temperature: 0 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Ollama did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`);
      }
      throw new Error(`Ollama is not running at ${this.baseUrl}. Start it and retry.`);
    }

    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 404) throw new Error(`Ollama does not have the model ${this.model}. Run: ollama pull ${this.model}`);
      throw new Error(`Ollama returned ${response.status}: ${detail}`);
    }
    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (typeof content !== "string") throw new Error("Ollama's reply had no message content");
    return content;
  }
}

export type OllamaStatus =
  | { status: "ready" }
  | { status: "not-running"; message: string }
  | { status: "no-model"; message: string };

/** Whether Ollama answers and has `model` pulled. The messages say what to do, since the user reads them in first-run setup. */
export async function checkOllama({
  baseUrl = DEFAULT_OLLAMA_URL,
  model = DEFAULT_SUMMARY_MODEL,
  timeoutMs = 5000,
}: { baseUrl?: string; model?: string; timeoutMs?: number } = {}): Promise<OllamaStatus> {
  const notRunning: OllamaStatus = {
    status: "not-running",
    message: `Ollama is not running at ${baseUrl}. Install it from ollama.com and start it, then check again.`,
  };
  let names: string[];
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return notRunning;
    names = ((await response.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return notRunning;
  }
  // A name without a tag means the latest one.
  const wanted = model.includes(":") ? model : `${model}:latest`;
  if (names.includes(wanted)) return { status: "ready" };
  return { status: "no-model", message: `Ollama is running but does not have ${model}. Run: ollama pull ${model}` };
}
