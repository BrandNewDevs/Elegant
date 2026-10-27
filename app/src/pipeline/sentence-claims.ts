import { InvalidSummaryError } from "./validate-summary.js";
import type { SourcePiece, SupportedFact } from "./grounded-format.js";

export interface OriginalSentence { id: string; sourceId: string; speaker: string; text: string }

/** A bare numbered agenda heading carries no Meeting decision or commitment. */
export function isBareAgendaHeading(text: string): boolean {
  const match = /^Review round \d+,\s*topic\s+([\p{L}\p{N}_-]+(?:[ \t]+[\p{L}\p{N}_-]+){0,5})\.\s*$/iu.exec(text);
  return !!match && !/\b(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|should|must|need|needs|require|requires|no|not|never)\b/iu.test(match[1]!);
}
// Wire codes are positions in this frozen vocabulary; prompts and decoding share it.
export const SENTENCE_KINDS = Object.freeze(["proposal", "decision", "commitment", "disagreement", "unresolved", "update", "procedure"] as const);
const KIND_CODES = Object.freeze(SENTENCE_KINDS.map((_, code) => code));

/** Application-owned IDs, text and attribution; the model classifies but cannot rewrite them. */
export function originalSentences(sources: SourcePiece[]): OriginalSentence[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return sources.flatMap(source => [...segmenter.segment(source.text)].flatMap((sentence, ordinal) => {
    const text = sentence.segment.trim();
    return text ? [{ id: `${source.id}:${ordinal}`, sourceId: source.id, speaker: source.speaker, text }] : [];
  }));
}

export function sentenceClassificationSchema(primary: OriginalSentence[]) {
  return { type: "object", properties: { classifications: { type: "array", items: { type: "integer", enum: KIND_CODES },
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
    const code = classifications[index];
    if (typeof code !== "number" || !Number.isInteger(code) || code < 0 || code >= SENTENCE_KINDS.length) {
      return invalid("Use a supplied integer sentence kind code from 0 to 6 for every primary position");
    }
    const kind = SENTENCE_KINDS[code]!;
    const source = sources.get(sentence.sourceId);
    if (!source || source.speaker !== sentence.speaker || !source.text.includes(sentence.text)) throw new Error("Original sentence identity changed during Summary extraction");
    if (kind !== "procedure") facts.push({ speaker: source.speaker, text: sentence.text, kind,
      refs: [source.ref], sources: [source] });
  }
  return facts;
}
