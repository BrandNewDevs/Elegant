import type { TextModel, TextRequest, TextResponse } from "./language-model.js";
import { requestBytes } from "./model-request.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
/** Separate from Ollama's limits: never change the local pipeline's request budget. */
export const GEMINI_INPUT_BYTES = 192_000;
const MAX_REPLY_BYTES = 512 * 1024;

export function validGeminiModel(model: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9.-]{0,99}$/.test(model);
}

class GeminiError extends Error {}
const failure = (status: number): string => {
  if (status === 400) return "Gemini rejected the request. Check the API key, model and supported settings.";
  if (status === 401 || status === 403) return "Gemini access was denied. Check your API key and project permissions in Settings.";
  if (status === 404) return "The selected Gemini model is unavailable. Choose an available text model in Settings.";
  if (status === 429) return "Gemini quota or rate limit reached. Check your Google account usage and retry later.";
  return "Gemini is temporarily unavailable. Retry later or choose Ollama in Settings.";
};

/** Only text goes to Google's fixed endpoint; credentials use a header, never a URL. */
export class GeminiClient implements TextModel {
  constructor(private readonly options: { apiKey: string; model?: string; fetch?: typeof fetch }) {
    if (!options.apiKey.trim() || /\s/.test(options.apiKey) || options.apiKey.length > 512) throw new Error("Enter a valid Gemini API key in Settings");
    if (!validGeminiModel(options.model ?? DEFAULT_GEMINI_MODEL)) throw new Error("Choose a valid Gemini model name");
  }

  async complete(request: TextRequest): Promise<TextResponse> {
    if (!request.messages.length || !request.messages.every(m => ["system", "user", "assistant"].includes(m.role) && typeof m.content === "string")) throw new Error("Invalid Gemini messages");
    if (requestBytes(request) > GEMINI_INPUT_BYTES) throw new Error("Gemini request exceeds its evidence budget; no partial result was saved");
    const timeoutMs = request.timeoutMs ?? 120_000;
    const maxOutputTokens = request.maxOutputTokens ?? 8192;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) throw new Error("Invalid Gemini request limits");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const model = this.options.model ?? DEFAULT_GEMINI_MODEL;
    const started = performance.now();
    try {
      signal.throwIfAborted();
      const response = await (this.options.fetch ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST", redirect: "error", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: request.messages.filter(m => m.role === "system").map(m => ({ text: m.content })) },
          contents: request.messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { temperature: 0, maxOutputTokens, ...(request.thinkingLevel ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } } : {}), responseMimeType: "application/json", responseJsonSchema: request.schema },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GeminiError(failure(response.status));
      }
      if (!response.body) throw new GeminiError("Gemini returned an empty response. Retry the request.");
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > MAX_REPLY_BYTES) { await reader.cancel(); throw new GeminiError("Gemini response exceeded its size limit"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      signal.throwIfAborted();
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new GeminiError("Gemini returned an invalid response. Retry the request."); }
      const candidate = body?.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") throw new GeminiError("Gemini reached its output token limit before completing. No partial result was saved.");
      if (candidate?.finishReason !== "STOP") throw new GeminiError("Gemini did not complete its answer, or blocked the request. No partial result was saved.");
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) throw new GeminiError("Gemini returned no answer text");
      const text = parts.filter(p => p && p.thought !== true && typeof p.text === "string").map(p => p.text).join("");
      if (!text.trim()) throw new GeminiError("Gemini returned no answer text");
      const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
      return { text, metadata: { model: typeof body.modelVersion === "string" && validGeminiModel(body.modelVersion) ? body.modelVersion : model, elapsedMs: performance.now() - started,
        promptTokens: count(body.usageMetadata?.promptTokenCount), outputTokens: count(body.usageMetadata?.candidatesTokenCount), thinkingTokens: count(body.usageMetadata?.thoughtsTokenCount) } };
    } catch (error) {
      if (request.signal?.aborted) {
        if (request.signal.reason?.name === "TimeoutError") throw Object.assign(new Error("Gemini processing exceeded its deadline. Retry or ask a narrower question."), { name: "TimeoutError" });
        throw Object.assign(new Error("Gemini request was cancelled"), { name: "AbortError" });
      }
      if (timeout.aborted) throw Object.assign(new Error("Gemini request timed out. Retry or ask a narrower question."), { name: "TimeoutError" });
      if (error instanceof GeminiError) throw error;
      // Fetch/SDK/server errors may contain credentials or speech; never forward them.
      throw new Error("Could not reach Gemini. Check your connection and retry.");
    }
  }
}
