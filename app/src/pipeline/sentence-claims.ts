import { InvalidSummaryError } from "./validate-summary.js";
import type { FactKind, SourcePiece, SupportedFact } from "./grounded-format.js";

export interface OriginalSentence { id: string; sourceId: string; speaker: string; text: string }
const KINDS = ["proposal", "decision", "commitment", "disagreement", "unresolved", "update", "procedure"] as const;

/** Application-owned IDs, text and attribution; the model classifies but cannot rewrite them. */
export function originalSentences(sources: SourcePiece[]): OriginalSentence[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return sources.flatMap(source => [...segmenter.segment(source.text)].flatMap((sentence, ordinal) => {
    const text = sentence.segment.trim();
    return text ? [{ id: `${source.id}:${ordinal}`, sourceId: source.id, speaker: source.speaker, text }] : [];
  }));
}

export function sentenceClassificationSchema(primary: OriginalSentence[]) {
  return { type: "object", properties: { classifications: { type: "array", items: { type: "string", enum: KINDS },
    minItems: primary.length, maxItems: primary.length } }, required: ["classifications"], additionalProperties: false };
}

/** Every primary sentence receives an explicit disposition before any facts are returned. */
export function parseSentenceClassifications(json: string, primary: OriginalSentence[], sources: Map<string, SourcePiece>): SupportedFact[] {
  const invalid = (message: string): never => { throw new InvalidSummaryError(message); };
  let value: unknown;
  try { value = JSON.parse(json); } catch { return invalid("Classifications must be a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("classifications" in value)
    || !Array.isArray(value.classifications)) {
    return invalid("Return classifications as an array in primary sentence order");
  }
  if (Object.keys(value).some(key => key !== "classifications")) return invalid("Return only classifications, never generated text or attribution");
  const classifications = value.classifications;
  if (classifications.length !== primary.length) return invalid("Classify every primary sentence exactly once in input order; array length must match primary length");
  const facts: SupportedFact[] = [];
  for (const [index, sentence] of primary.entries()) {
    const kind = classifications[index];
    if (typeof kind !== "string" || !KINDS.some(allowed => allowed === kind)) return invalid("Use a supplied sentence kind or procedure for every primary position");
    const source = sources.get(sentence.sourceId);
    if (!source || source.speaker !== sentence.speaker || !source.text.includes(sentence.text)) throw new Error("Original sentence identity changed during Summary extraction");
    if (kind !== "procedure") facts.push({ speaker: source.speaker, text: sentence.text, kind: kind as FactKind,
      refs: [source.ref], sources: [source] });
  }
  return facts;
}
