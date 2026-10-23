import type { LanguageModel } from "../pipeline/language-model.js";

/** A scripted stand-in for Ollama. Each call is answered by `reply`; the prompts it saw are kept for assertions. */
export class FakeModel implements LanguageModel {
  readonly prompts: string[] = [];

  constructor(private readonly reply: (prompt: string, call: number) => unknown) {}

  async generate(request: { prompt: string }): Promise<string> {
    this.prompts.push(request.prompt);
    const out = this.reply(request.prompt, this.prompts.length);
    return typeof out === "string" ? out : JSON.stringify(out);
  }
}
