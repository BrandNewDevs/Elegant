/** What the summariser needs from a language model: a prompt in, JSON text out shaped by `schema`. */
export interface LanguageModel {
  generate(request: { prompt: string; schema: object }): Promise<string>;
}
