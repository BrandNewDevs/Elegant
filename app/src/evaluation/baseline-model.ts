// Frozen Ollama generation settings from main 1ee9d82; do not tune.
import type { LanguageModel } from "../pipeline/language-model.js";

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
export class BaselineOllamaClient implements LanguageModel {
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

