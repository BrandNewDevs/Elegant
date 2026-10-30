/** Compatibility interface for the original Summary implementation. */
export interface LanguageModel {
  generate(request: { prompt: string; schema: object; signal?: AbortSignal }): Promise<string>;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TextRequest {
  messages: ModelMessage[];
  schema: object;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  thinkingLevel?: "low";
}

/** Operational measurements only: never prompts, Transcript text or generated content. */
export interface GenerationMetadata {
  model: string;
  elapsedMs: number;
  promptTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  loadDurationNs?: number;
}

export interface TextResponse {
  text: string;
  metadata: GenerationMetadata;
}

export interface TextModel {
  complete(request: TextRequest): Promise<TextResponse>;
}
