import { InvalidSummaryError } from "./validate-summary.js";

export type { SourceFragment as SourcePiece } from "./evidence.js";
import type { SourceFragment as SourcePiece } from "./evidence.js";
export type FactKind = "proposal" | "decision" | "commitment" | "disagreement" | "unresolved" | "update";
export interface SupportedPoint { speaker: string; text: string; refs: number[] }
export interface SupportedFact extends SupportedPoint { kind: FactKind; sources: SourcePiece[] }
export interface GroundedOutput { tldr: string; tldrRefs: number[]; points: SupportedPoint[] }

const refsSchema = { type: "array", items: { type: "integer" }, minItems: 1, uniqueItems: true };
const pointProperties = { speaker: { type: "string" }, text: { type: "string" }, refs: refsSchema };
export const GROUNDED_SCHEMA = {
  type: "object", properties: {
    tldr: { type: "string" }, tldrRefs: refsSchema,
    points: { type: "array", items: { type: "object", properties: pointProperties, required: ["speaker", "text", "refs"] } },
  }, required: ["tldr", "tldrRefs", "points"],
};
export const FACTS_SCHEMA = {
  type: "object", properties: { facts: { type: "array", items: {
    type: "object", properties: { speaker: pointProperties.speaker, text: pointProperties.text, sourceIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true }, kind: { type: "string", enum: ["proposal", "decision", "commitment", "disagreement", "unresolved", "update"] } },
    required: ["speaker", "text", "kind", "sourceIds"],
  } } }, required: ["facts"],
};

/** Restrict structured output to evidence that was actually supplied in this request. */
export function groundedSchema(sources: SourcePiece[]) {
  const refs = { ...refsSchema, items: { type: "integer", enum: [...new Set(sources.map(source => source.ref))] } };
  return { ...GROUNDED_SCHEMA, properties: { ...GROUNDED_SCHEMA.properties, tldrRefs: refs,
    points: { ...GROUNDED_SCHEMA.properties.points, items: { ...GROUNDED_SCHEMA.properties.points.items,
      properties: { ...pointProperties, refs, speaker: { type: "string", enum: [...new Set(sources.map(source => source.speaker))] } } } } } };
}
export function factsSchema(sources: SourcePiece[], speakers = sources) {
  const facts = FACTS_SCHEMA.properties.facts;
  return { ...FACTS_SCHEMA, properties: { facts: { ...facts, items: { ...facts.items, properties: { ...facts.items.properties,
    speaker: { type: "string", enum: [...new Set(speakers.map(source => source.speaker))] },
    sourceIds: { ...facts.items.properties.sourceIds, items: { type: "string", enum: sources.map(source => source.id) } },
  } } } } };
}

/** Consolidation must account for every candidate without moving contributions between speakers. */
export function reductionSchema(sources: SourcePiece[], candidates: SupportedFact[]) {
  const schema = factsSchema(sources);
  const facts = schema.properties.facts;
  return { ...schema, properties: { facts: { ...facts, items: { ...facts.items, properties: { ...facts.items.properties,
    covers: { type: "array", minItems: 1, uniqueItems: true, items: { type: "integer", enum: candidates.map((_, index) => index) } },
  }, required: [...facts.items.required, "covers"] } } } };
}
export function tldrSchema(sources: SourcePiece[]) {
  return { type: "object", properties: { tldr: { type: "string" },
    sourceIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: sources.map(source => source.id) } },
  }, required: ["tldr", "sourceIds"] };
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
function point(value: unknown, sources: SourcePiece[]): SupportedPoint {
  if (!record(value)) return problem("Every point must be an object");
  const speaker = text(value.speaker);
  const refs = references(value.refs, sources);
  if (!sources.some(source => source.speaker === speaker && refs.includes(source.ref))) return problem("Attribute each point to a supplied speaker with that speaker's evidence");
  return { speaker, text: text(value.text), refs };
}
export function parseGrounded(json: string, sources: SourcePiece[]): GroundedOutput {
  const value = object(json);
  if (!Array.isArray(value.points)) return problem("points must be a list");
  return { tldr: text(value.tldr), tldrRefs: references(value.tldrRefs, sources), points: value.points.map(value => point(value, sources)) };
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
    if (ids.some(id => draft[id]!.speaker !== speaker)) return problem("A refined point may cover only draft points by the same speaker");
    ids.forEach(id => covered.add(id));
    return { speaker, text: text(value.text), refs: [...new Set(ids.flatMap(id => draft[id]!.refs))].sort((a, b) => a - b) };
  });
  if (covered.size !== draft.length) return problem("Every original draft point must be covered by a refined point");
  return points;
}

export function parseFacts(json: string, sources: SourcePiece[], primary?: SourcePiece[]): SupportedFact[] {
  const value = object(json);
  if (!Array.isArray(value.facts)) return problem("facts must be a list");
  return value.facts.map(value => {
    if (!record(value) || typeof value.kind !== "string" || !["proposal", "decision", "commitment", "disagreement", "unresolved", "update"].includes(value.kind)) return problem("Use a supported fact kind");
    if (!Array.isArray(value.sourceIds) || !value.sourceIds.length || !value.sourceIds.every(id => typeof id === "string" && sources.some(source => source.id === id))) return problem("Cite sourceIds supplied with the original passages");
    const selected = sources.filter(source => (value.sourceIds as string[]).includes(source.id));
    // The model cites one identifier system. Derive public ordinals from validated original pieces.
    const p = point({ ...value, refs: [...new Set(selected.map(source => source.ref))] }, selected);
    if (primary && !selected.some(source => source.speaker === p.speaker && primary.some(piece => piece.id === source.id))) return problem("Extract only points made by speakers in the primary source pieces");
    return { ...p, kind: value.kind as FactKind, sources: selected };
  });
}

export function parseReducedFacts(json: string, sources: SourcePiece[], candidates: SupportedFact[]): SupportedFact[] {
  const value = object(json);
  const facts = parseFacts(json, sources);
  const covered = new Set<number>();
  (value.facts as unknown[]).forEach((raw, index) => {
    if (!record(raw) || !Array.isArray(raw.covers) || !raw.covers.length
        || !raw.covers.every(id => Number.isInteger(id) && id >= 0 && id < candidates.length)) return problem("Use the supplied candidate IDs in covers");
    for (const id of new Set(raw.covers as number[])) {
      if (covered.has(id)) return problem("Every candidate must be covered exactly once");
      if (candidates[id]!.speaker !== facts[index]!.speaker) return problem("Cover only candidates by the same speaker; other speakers' sources may clarify corrections");
      covered.add(id);
    }
  });
  if (covered.size !== candidates.length) return problem("Every input candidate must be represented in covers; do not discard distinct facts");
  return facts;
}
export function parseTldrSources(json: string, sources: SourcePiece[]): { tldr: string; tldrRefs: number[] } {
  const value = object(json);
  if (!Array.isArray(value.sourceIds) || !value.sourceIds.length
      || !value.sourceIds.every(id => typeof id === "string" && sources.some(source => source.id === id))) return problem("Cite original sourceIds supplied with the TLDR facts");
  return { tldr: text(value.tldr), tldrRefs: [...new Set(sources.filter(source => (value.sourceIds as string[]).includes(source.id)).map(source => source.ref))].sort((a, b) => a - b) };
}

/** Source pieces are original text, never generated intermediate prose. */
export function uniqueSources(sources: SourcePiece[]): SourcePiece[] {
  return [...new Map(sources.map(source => [`${source.ref}:${source.part}`, source])).values()]
    .sort((a, b) => a.ref - b.ref || a.part - b.part);
}
