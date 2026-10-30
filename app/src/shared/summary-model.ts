/** The Summary model Elegant's prompts, schemas and validation were written and tested against. */
export const DEFAULT_SUMMARY_MODEL = "gemma3:4b";

/** An Ollama model name such as `gemma3:4b` or `hf.co/user/repo:Q4_K_M`. */
export function isModelName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/.test(value);
}
