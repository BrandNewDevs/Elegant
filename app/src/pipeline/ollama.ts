import type { LanguageModel, TextModel, TextRequest, TextResponse } from "./language-model.js";
import { AI_SETTINGS, assertRequestBudget } from "./model-request.js";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  numCtx?: number;
  timeoutMs?: number;
}

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEFAULT_SUMMARY_MODEL = AI_SETTINGS.model;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 64 * 1024;

/** Prevent an accidental cloud endpoint or redirect from receiving Meeting content. */
function localUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Ollama must use a local loopback URL without credentials or a path");
  }
  return url.origin;
}

class InvalidOllamaReply extends Error {}

/** Read a bounded body while the fetch signal still owns cancellation and timeout. */
async function readReply(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new InvalidOllamaReply("Ollama's reply had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new InvalidOllamaReply("Ollama's reply exceeded the response size limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    signal.throwIfAborted();
    try { return JSON.parse(text); }
    catch { throw new InvalidOllamaReply("Ollama's reply was not valid JSON"); }
  } finally { reader.releaseLock(); }
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Local text generation; callers validate JSON semantics separately from transport structure. */
export class OllamaClient implements LanguageModel, TextModel {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly timeoutMs: number;

  constructor({ baseUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_SUMMARY_MODEL, numCtx = AI_SETTINGS.numCtx, timeoutMs = AI_SETTINGS.timeoutMs }: OllamaOptions = {}) {
    this.baseUrl = localUrl(baseUrl);
    this.model = model;
    this.numCtx = numCtx;
    this.timeoutMs = timeoutMs;
    if (!Number.isSafeInteger(numCtx) || numCtx <= AI_SETTINGS.maxOutputTokens) throw new Error("Ollama context must leave room for its response budget");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Ollama timeout must be a positive number of milliseconds");
  }

  async generate({ prompt, schema, signal }: { prompt: string; schema: object; signal?: AbortSignal }): Promise<string> {
    return (await this.complete({ messages: [{ role: "user", content: prompt }], schema, signal })).text;
  }

  async complete(request: TextRequest): Promise<TextResponse> {
    assertRequestBudget(request);
    if (!request.messages.length || !request.messages.every(message => ["system", "user", "assistant"].includes(message.role) && typeof message.content === "string")) {
      throw new Error("AI request must contain valid text messages");
    }
    const timeoutMs = request.timeoutMs ?? this.timeoutMs;
    const maxOutputTokens = request.maxOutputTokens ?? AI_SETTINGS.maxOutputTokens;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("AI timeout must be a positive number of milliseconds");
    if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > AI_SETTINGS.maxOutputTokens) throw new Error(`AI response budget must be between 1 and ${AI_SETTINGS.maxOutputTokens} tokens`);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const started = performance.now();
    try {
      signal.throwIfAborted();
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        redirect: "error",
        body: JSON.stringify({ model: this.model, messages: request.messages, stream: false, format: request.schema, think: AI_SETTINGS.think,
          options: { num_ctx: this.numCtx, num_predict: maxOutputTokens, temperature: AI_SETTINGS.temperature } }),
        signal,
      });
      if (!response.ok) {
        // Server errors can echo prompts. Never include their body in application errors.
        await response.body?.cancel();
        if (response.status === 404) throw new InvalidOllamaReply(`Ollama does not have the model ${this.model}. Run: ollama pull ${this.model}`);
        throw new InvalidOllamaReply(`Ollama returned HTTP ${response.status}. Check the local server and retry.`);
      }
      const value = await readReply(response, signal);
      if (!value || typeof value !== "object") throw new InvalidOllamaReply("Ollama's reply had no message content");
      const body = value as { message?: { content?: unknown }; done?: unknown; done_reason?: unknown; prompt_eval_count?: unknown; eval_count?: unknown; load_duration?: unknown };
      const content = body.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new InvalidOllamaReply("Ollama's reply had no message content");
      if (body.done !== true || body.done_reason === "length") throw new InvalidOllamaReply("Ollama did not complete its response within the output budget");
      if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) throw new InvalidOllamaReply("Ollama's generated content exceeded the response size limit");
      const promptTokens = count(body.prompt_eval_count);
      if (promptTokens !== undefined && promptTokens > this.numCtx - maxOutputTokens) throw new InvalidOllamaReply("Ollama's prompt-token count left insufficient response room; reduce the input budget");
      return { text: content, metadata: { model: this.model, elapsedMs: performance.now() - started,
        promptTokens, outputTokens: count(body.eval_count), loadDurationNs: count(body.load_duration) } };
    } catch (error) {
      if (request.signal?.aborted) throw Object.assign(new Error("AI request was cancelled"), { name: "AbortError" });
      if (timeout.aborted) throw Object.assign(new Error(`Ollama did not answer within ${Math.ceil(timeoutMs / 1000)} seconds`), { name: "TimeoutError" });
      if (error instanceof InvalidOllamaReply) throw error;
      throw new Error(`Ollama is not running at ${this.baseUrl}. Start it and retry.`);
    }
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
  baseUrl = localUrl(baseUrl);
  const notRunning: OllamaStatus = {
    status: "not-running",
    message: `Ollama is not running at ${baseUrl}. Install it from ollama.com and start it, then check again.`,
  };
  let names: string[];
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
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
