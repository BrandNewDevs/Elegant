import type { GeminiModelOption } from "../shared/ai-settings.js";
import type { TextModel, TextRequest, TextResponse } from "./language-model.js";
import { requestBytes } from "./model-request.js";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
/** Separate from Ollama's limits: never change the local pipeline's request budget. */
export const GEMINI_INPUT_BYTES = 192_000;
const MAX_REPLY_BYTES = 512 * 1024;

export function validGeminiModel(model: string): boolean {
  return /^gemini-[a-z0-9][a-z0-9.-]{0,99}$/.test(model);
}

/** What Google said, in terms the app can act on. `status` is absent for a reply that came back 200 but was not a finished answer. */
interface GeminiErrorDetail { status?: number; limitZero?: boolean; retryDelaySeconds?: number }
export class GeminiError extends Error {
  constructor(message: string, readonly detail: GeminiErrorDetail = {}) { super(message); }
}

/** The reply's first bytes only: a quota error is small, and nothing else is read. */
async function readSmall(response: Response, limit = 16 * 1024): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      size += part.value.byteLength;
    }
    await reader.cancel();
  } catch { /* A reply that cannot be read is treated as empty. */ } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8").slice(0, limit);
}

const safeToken = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9_./-]{1,120}$/.test(value) ? value : undefined);

/**
 * Why Google refused for quota, from the structured parts of its 429 only: the quota's id, the model, the retry delay, and
 * whether the limit is zero (the model is not on the plan at all). Its free-text message is never forwarded, because an
 * error body can echo what was sent; each value taken is a short token that passes a strict pattern.
 */
export function parseQuota(body: string, requestedModel?: string): { message: string; limitZero: boolean; retryDelaySeconds?: number } {
  let error: { message?: unknown; details?: unknown } | undefined;
  try { error = (JSON.parse(body) as { error?: typeof error }).error; } catch { /* Not JSON: say the general thing. */ }
  const details = Array.isArray(error?.details) ? (error.details as Record<string, unknown>[]) : [];
  const violation = details.flatMap(d => (Array.isArray(d?.violations) ? (d.violations as Record<string, unknown>[]) : []))[0];
  const dimensions = violation?.quotaDimensions as Record<string, unknown> | undefined;
  const quota = safeToken(violation?.quotaId);
  const model = safeToken(dimensions?.model) ?? safeToken(requestedModel);
  const retry = details.map(d => safeToken(d?.retryDelay)).find(Boolean);
  const retryDelaySeconds = retry && /^\d+(\.\d+)?s$/.test(retry) ? Number.parseFloat(retry) : undefined;
  const text = typeof error?.message === "string" ? error.message : "";
  const limitZero = /limit:\s*0\b/.test(text);
  const where = [model && `for ${model}`, quota && `(${quota})`].filter(Boolean).join(" ");
  const message = `Gemini quota or rate limit reached${where ? ` ${where}` : ""}. ` +
    (limitZero ? "This model has no quota on your plan: choose another model, or enable billing in Google AI Studio. " : "") +
    (retry ? `Retry in ${retry}.` : "Check your Google account usage and retry later.");
  return { message, limitZero, retryDelaySeconds };
}

export const quotaMessage = (body: string, requestedModel?: string): string => parseQuota(body, requestedModel).message;

/** The message for a refused request. Only a 429 is read, for the quota it names; every other reply is dropped unread. */
async function refusal(response: Response, model?: string): Promise<GeminiError> {
  if (response.status !== 429) {
    await response.body?.cancel();
    return new GeminiError(failure(response.status), { status: response.status });
  }
  const { message, limitZero, retryDelaySeconds } = parseQuota(await readSmall(response), model);
  return new GeminiError(message, { status: 429, limitZero, retryDelaySeconds });
}
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
          generationConfig: { temperature: 0, maxOutputTokens, responseMimeType: "application/json", responseJsonSchema: request.schema },
        }),
      });
      if (!response.ok) throw await refusal(response, model);
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

/** Models that can generate text but are for something else: images, speech, live audio, embeddings or agents. */
const NOT_A_TEXT_MODEL = /embedding|-image|image-|-tts|-live|live-|native-audio|-audio|computer-use|robotics|aqa/;
const MAX_PAGES = 5;

/**
 * The Gemini text models this key can use, asked of Google's models list: those that support `generateContent` and are not
 * image, speech, live-audio or embedding variants. Only the key goes out, in a header, to the fixed endpoint; nothing from a
 * Meeting is sent, and Google's error bodies are never forwarded.
 */
export async function listGeminiModels({ apiKey, signal, fetch: fetcher = fetch }: { apiKey: string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<GeminiModelOption[]> {
  if (!apiKey.trim() || /\s/.test(apiKey) || apiKey.length > 512) throw new Error("Enter a valid Gemini API key in Settings");
  const timeout = AbortSignal.timeout(20_000);
  const aborted = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const found = new Map<string, string>();
  try {
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      aborted.throwIfAborted();
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await fetcher(url, { redirect: "error", signal: aborted, headers: { "x-goog-api-key": apiKey } });
      if (!response.ok) throw await refusal(response);
      const text = await response.text();
      if (text.length > MAX_REPLY_BYTES) throw new GeminiError("Gemini's model list exceeded its size limit");
      let body: { models?: unknown; nextPageToken?: unknown };
      try { body = JSON.parse(text); } catch { throw new GeminiError("Gemini returned an invalid model list. Retry the request."); }
      if (!Array.isArray(body.models)) throw new GeminiError("Gemini returned no model list. Retry the request.");
      for (const entry of body.models as { name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }[]) {
        const id = typeof entry?.name === "string" && entry.name.startsWith("models/") ? entry.name.slice("models/".length) : "";
        const methods = Array.isArray(entry?.supportedGenerationMethods) ? entry.supportedGenerationMethods : [];
        if (!validGeminiModel(id) || NOT_A_TEXT_MODEL.test(id) || !methods.includes("generateContent")) continue;
        found.set(id, typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName.trim().slice(0, 80) : id);
      }
      if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break;
      pageToken = body.nextPageToken;
    }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error("The model list request was cancelled"), { name: "AbortError" });
    if (timeout.aborted) throw Object.assign(new Error("Gemini did not answer in time. Retry the request."), { name: "TimeoutError" });
    if (error instanceof GeminiError) throw error;
    throw new Error("Could not reach Gemini. Check your connection and retry.");
  }
  return [...found].map(([id, label]) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id));
}

/** How one model answered a tiny test request: it did, Google has no quota for it on this plan, it is rate-limited right now, or it is unavailable. */
export type ModelProbe = "ok" | "no-quota" | "busy" | "unavailable";

/**
 * Sends one synthetic request (never Meeting content) to see whether this key can use the model. A model that answers, even
 * with an unfinished reply, is usable; a 429 with a limit of zero means it is not on the plan. Anything that is not about the
 * model itself, such as no network, is thrown so the caller stops instead of calling every model unavailable.
 */
export async function probeGeminiModel({ apiKey, model, signal, fetch: fetcher }: { apiKey: string; model: string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<ModelProbe> {
  try {
    await new GeminiClient({ apiKey, model, fetch: fetcher }).complete({
      messages: [{ role: "user", content: 'Connection test only. Return {"ok":true}.' }],
      schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, signal, timeoutMs: 30_000, maxOutputTokens: 1024 });
    return "ok";
  } catch (error) {
    if (signal?.aborted || !(error instanceof GeminiError)) throw error;
    const { status, limitZero } = error.detail;
    if (status === undefined) return "ok"; // a 200 that was not a finished answer: the model is there
    if (status === 429) return limitZero ? "no-quota" : "busy";
    return "unavailable";
  }
}
