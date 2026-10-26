import type { TextRequest } from "./language-model.js";

/** Shared by generation, readiness checks and request construction. */
export const AI_SETTINGS = Object.freeze({
  model: "gemma3:4b",
  numCtx: 8192,
  maxOutputTokens: 2048,
  maxInputBytes: 5500,
  timeoutMs: 5 * 60_000,
  temperature: 0,
});

/** Conservative input accounting, including schema, message roles, history and retry instructions. */
export function requestBytes(request: Pick<TextRequest, "messages" | "schema">): number {
  return Buffer.byteLength(JSON.stringify({ messages: request.messages, schema: request.schema }), "utf8");
}

export function assertRequestBudget(request: Pick<TextRequest, "messages" | "schema">, maxBytes: number = AI_SETTINGS.maxInputBytes): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("AI input budget must be a positive integer");
  if (requestBytes(request) > maxBytes) throw new Error(`AI request exceeds the ${maxBytes}-byte input budget; split the evidence before generation`);
}
