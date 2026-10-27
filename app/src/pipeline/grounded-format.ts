import { InvalidSummaryError } from "./validate-summary.js";

export type { SourceFragment as SourcePiece } from "./evidence.js";
import type { SourceFragment as SourcePiece } from "./evidence.js";
export type FactKind = "proposal" | "decision" | "commitment" | "disagreement" | "unresolved" | "update";
export interface SupportedPoint { speaker: string; text: string; refs: number[] }
export interface SupportedFact extends SupportedPoint { kind: FactKind; sources: SourcePiece[]; leaves?: SupportedFact[] }
export interface GroundedOutput { tldr: string; tldrRefs: number[]; points: SupportedPoint[] }

const refsSchema = { type: "array", items: { type: "integer" }, minItems: 1, uniqueItems: true };
const pointProperties = { speaker: { type: "string" }, text: { type: "string" }, refs: refsSchema };
export const GROUNDED_SCHEMA = {
  type: "object", properties: {
    // Generate claims first; TLDR selection cannot author a different factual claim.
    points: { type: "array", items: { type: "object", properties: pointProperties, required: ["speaker", "text", "refs"] } },
    tldrPointIds: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "integer", minimum: 0 } },
  }, required: ["points", "tldrPointIds"],
};
/** Restrict structured output to evidence that was actually supplied in this request. */
export function groundedSchema(sources: SourcePiece[]) {
  const speakers = [...new Set(sources.map(source => source.speaker))];
  return { ...GROUNDED_SCHEMA, properties: { ...GROUNDED_SCHEMA.properties,
    points: { ...GROUNDED_SCHEMA.properties.points, items: { anyOf: speakers.map(speaker => ({
      type: "object", properties: { ...pointProperties, speaker: { type: "string", enum: [speaker] },
        refs: { ...refsSchema, items: { type: "integer", enum: [...new Set(sources.filter(source => source.speaker === speaker).map(source => source.ref))] } },
      }, required: ["speaker", "text", "refs"], additionalProperties: false,
    })) } },
  } };
}
/** Consolidation must account for every candidate without moving contributions between speakers. */
export function reductionSchema(_sources: SourcePiece[], candidates: readonly unknown[]) {
  // Every candidate has a required assignment; the model cannot omit claims or
  // generate replacement prose, speakers, kinds or citations.
  return { type: "object", properties: Object.fromEntries(candidates.map((_, id) => [String(id), {
    type: "integer", enum: Array.from({ length: id + 1 }, (_, seed) => seed),
  }])), required: candidates.map((_, id) => String(id)), additionalProperties: false };
}

export function parseFactAssignments(json: string, candidates: SupportedFact[]): number[] {
  const value = object(json);
  const missing = candidates.map((_, id) => id).filter(id => !Object.hasOwn(value, String(id)));
  if (missing.length) return problem(coverageReason("Missing candidate IDs", missing, candidates));
  if (Object.keys(value).some(key => !candidates.some((_, id) => key === String(id)))) return problem("Use only the supplied candidate ID keys");
  return candidates.map((_, id) => {
    const seed = value[String(id)];
    if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > id) return problem(`Candidate ID ${id} needs an integer group ID between 0 and ${id}`);
    return seed;
  });
}
export function tldrSchema(candidates: readonly unknown[]) {
  return { type: "object", properties: { candidateIds: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true,
    items: { type: "integer", enum: candidates.map((_, id) => id) },
  } }, required: ["candidateIds"], additionalProperties: false };
}

/** Refinement cites draft point IDs; application code carries their original evidence forward. */
export function refinementSchema(points: SupportedPoint[]) {
  return { type: "object", properties: { points: { type: "array", items: { type: "object", properties: {
    speaker: { type: "string", enum: [...new Set(points.map(point => point.speaker))] }, text: { type: "string" },
    covers: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", enum: points.map((_, index) => index) } },
  }, required: ["speaker", "text", "covers"] } } }, required: ["points"] };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const problem = (message: string): never => { throw new InvalidSummaryError(message); };
/** Diagnostics contain only local IDs and original speaker labels, never candidate or Transcript prose. */
function coverageReason(prefix: string, ids: number[], points: { speaker: string }[]): string {
  const listed = ids.slice(0, 4).map(id => `${id}(${points[id]!.speaker})`).join(", ");
  const more = ids.length > 4 ? ` +${ids.length - 4} more` : "";
  return `${prefix}: ${listed}${more}. Cover every required ID once under its original speaker.`
    .replace(/[^\x20-\x7e]|["\\]/g, " ").slice(0, 160);
}
function object(json: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return problem("Output must be a JSON object"); }
  return record(value) ? value : problem("Output must be a JSON object");
}
function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : problem("Summary text must not be blank");
}
function references(value: unknown, sources: SourcePiece[]): number[] {
  const available = new Set(sources.map(source => source.ref));
  if (!Array.isArray(value) || !value.length || !value.every(ref => Number.isInteger(ref) && available.has(ref))) return problem("Use source references supplied in this request");
  // Repeating a valid identifier adds no evidence; normalize without spending a model retry.
  return [...new Set(value)].sort((a, b) => a - b) as number[];
}
function point(value: unknown, sources: SourcePiece[], ownSpeechOnly = false): SupportedPoint {
  if (!record(value)) return problem("Every point must be an object");
  const speaker = text(value.speaker);
  const refs = references(value.refs, sources);
  if (!sources.some(source => source.speaker === speaker && refs.includes(source.ref))) return problem("Attribute each point to a supplied speaker with that speaker's evidence");
  if (ownSpeechOnly && !refs.every(ref => sources.some(source => source.ref === ref && source.speaker === speaker))) {
    return problem("Direct Participant points must cite only their own speech; put another speaker's correction under that speaker");
  }
  return { speaker, text: text(value.text), refs };
}
export function parseGrounded(json: string, sources: SourcePiece[]): GroundedOutput {
  const value = object(json);
  if (!Array.isArray(value.points)) return problem("points must be a list");
  const points = value.points.map(value => point(value, sources, true));
  return { ...composeTldr(value.tldrPointIds, points), points };
}
export function parseRefinedPoints(json: string, draft: SupportedPoint[]): SupportedPoint[] {
  const value = object(json);
  if (!Array.isArray(value.points)) return problem("Refined points must be a list");
  const covered = new Set<number>();
  const points = value.points.map(value => {
    if (!record(value)) return problem("Every refined point must be an object");
    const speaker = text(value.speaker);
    if (!Array.isArray(value.covers) || !value.covers.length || !value.covers.every(id => Number.isInteger(id) && id >= 0 && id < draft.length)) return problem("Use the supplied draft point IDs in covers");
    const ids = [...new Set(value.covers)] as number[];
    const wrongSpeaker = ids.filter(id => draft[id]!.speaker !== speaker);
    if (wrongSpeaker.length) return problem(coverageReason("Wrong speaker for draft IDs", wrongSpeaker, draft));
    ids.forEach(id => covered.add(id));
    return { speaker, text: text(value.text), refs: [...new Set(ids.flatMap(id => draft[id]!.refs))].sort((a, b) => a - b) };
  });
  if (covered.size !== draft.length) return problem(coverageReason("Missing draft IDs", draft.map((_, id) => id).filter(id => !covered.has(id)), draft));
  return points;
}

/** Whole immutable claims keep a TLDR from transferring another task's date or owner. */
function composeTldr(value: unknown, points: SupportedPoint[]): { tldr: string; tldrRefs: number[] } {
  if (!Array.isArray(value) || !value.length
      || !value.every(id => Number.isInteger(id) && id >= 0 && id < points.length)) return problem("Select supplied point IDs for the TLDR");
  const ids = [...new Set(value)] as number[];
  if (ids.length > 3) return problem("Select at most three distinct whole claims for the TLDR");
  const selected = ids.map(id => points[id]!);
  return { tldr: selected.map(point => `${point.speaker}: ${point.text}`).join(" "),
    tldrRefs: [...new Set(selected.flatMap(point => point.refs))].sort((a, b) => a - b) };
}
export function parseTldrSelection(json: string, candidates: SupportedPoint[]): { tldr: string; tldrRefs: number[] } {
  return composeTldr(object(json).candidateIds, candidates);
}

/** Source pieces are original text, never generated intermediate prose. */
export function uniqueSources(sources: SourcePiece[]): SourcePiece[] {
  return [...new Map(sources.map(source => [`${source.ref}:${source.part}`, source])).values()]
    .sort((a, b) => a.ref - b.ref || a.part - b.part);
}
