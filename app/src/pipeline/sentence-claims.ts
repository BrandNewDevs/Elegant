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
  return { type: "object", $defs: { kind: { type: "string", enum: KINDS } },
    properties: { classifications: { type: "object", properties: Object.fromEntries(primary.map(sentence => [sentence.id, {
      $ref: "#/$defs/kind",
    }])), required: primary.map(sentence => sentence.id), additionalProperties: false } }, required: ["classifications"], additionalProperties: false };
}

/** Every primary sentence receives an explicit disposition before any facts are returned. */
export function parseSentenceClassifications(json: string, primary: OriginalSentence[], sources: Map<string, SourcePiece>): SupportedFact[] {
  const invalid = (message: string): never => { throw new InvalidSummaryError(message); };
  let value: unknown;
  try { value = JSON.parse(json); } catch { return invalid("Classifications must be a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("classifications" in value)
    || !value.classifications || typeof value.classifications !== "object" || Array.isArray(value.classifications)) {
    return invalid("Return classifications for every primary sentence ID");
  }
  if (Object.keys(value).some(key => key !== "classifications")) return invalid("Return only classifications, never generated text or attribution");
  const classifications = value.classifications as Record<string, unknown>;
  const missing = primary.filter(sentence => !Object.hasOwn(classifications, sentence.id));
  if (missing.length) return invalid(`Classify every primary sentence ID; missing ${missing.slice(0, 4).map(sentence => sentence.id).join(", ")}`);
  if (Object.keys(classifications).some(id => !primary.some(sentence => sentence.id === id))) return invalid("Classify only supplied primary sentence IDs, never context IDs");
  const facts: SupportedFact[] = [];
  for (const sentence of primary) {
    const kind = classifications[sentence.id];
    if (typeof kind !== "string" || !KINDS.some(allowed => allowed === kind)) return invalid("Use a supplied sentence kind or procedure for every primary ID");
    const source = sources.get(sentence.sourceId);
    if (!source || source.speaker !== sentence.speaker || !source.text.includes(sentence.text)) throw new Error("Original sentence identity changed during Summary extraction");
    if (kind !== "procedure") facts.push({ speaker: source.speaker, text: sentence.text, kind: kind as FactKind,
      refs: [source.ref], sources: [source] });
  }
  return facts;
}
