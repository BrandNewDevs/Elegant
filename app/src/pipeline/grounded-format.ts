import { InvalidSummaryError } from "./validate-summary.js";

export interface SourcePiece { id: string; ref: number; part: number; speaker: string; start: number; end: number; text: string }
export type FactKind = "proposal" | "decision" | "commitment" | "disagreement" | "unresolved" | "update";
export interface SupportedPoint { speaker: string; text: string; refs: number[] }
export interface SupportedFact extends SupportedPoint { kind: FactKind; sources: SourcePiece[] }
export interface GroundedOutput { tldr: string; tldrRefs: number[]; points: SupportedPoint[] }

const refsSchema = { type: "array", items: { type: "integer" }, minItems: 1 };
const pointProperties = { speaker: { type: "string" }, text: { type: "string" }, refs: refsSchema };
export const GROUNDED_SCHEMA = {
  type: "object", properties: {
    tldr: { type: "string" }, tldrRefs: refsSchema,
    points: { type: "array", items: { type: "object", properties: pointProperties, required: ["speaker", "text", "refs"] } },
  }, required: ["tldr", "tldrRefs", "points"],
};
export const FACTS_SCHEMA = {
  type: "object", properties: { facts: { type: "array", items: {
    type: "object", properties: { ...pointProperties, sourceIds: { type: "array", items: { type: "string" }, minItems: 1 }, kind: { type: "string", enum: ["proposal", "decision", "commitment", "disagreement", "unresolved", "update"] } },
    required: ["speaker", "text", "refs", "kind", "sourceIds"],
  } } }, required: ["facts"],
};

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
  if (!Array.isArray(value) || !value.length || !value.every(ref => Number.isInteger(ref) && available.has(ref))
      || new Set(value).size !== value.length) return problem("Use distinct source references supplied in this request");
  return [...value].sort((a, b) => a - b) as number[];
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
export function parseFacts(json: string, sources: SourcePiece[], primary?: SourcePiece[]): SupportedFact[] {
  const value = object(json);
  if (!Array.isArray(value.facts)) return problem("facts must be a list");
  return value.facts.map(value => {
    if (!record(value) || typeof value.kind !== "string" || !["proposal", "decision", "commitment", "disagreement", "unresolved", "update"].includes(value.kind)) return problem("Use a supported fact kind");
    if (!Array.isArray(value.sourceIds) || !value.sourceIds.length || !value.sourceIds.every(id => typeof id === "string" && sources.some(source => source.id === id))
        || new Set(value.sourceIds).size !== value.sourceIds.length) return problem("Cite distinct sourceIds supplied with the original passages");
    const selected = sources.filter(source => (value.sourceIds as string[]).includes(source.id));
    const p = point(value, selected);
    if (selected.some(source => !p.refs.includes(source.ref))) return problem("Every cited sourceId must belong to a cited segment ref");
    if (primary && !selected.some(source => source.speaker === p.speaker && primary.some(piece => piece.id === source.id))) return problem("Extract only points made by speakers in the primary source pieces");
    return { ...p, kind: value.kind as FactKind, sources: selected };
  });
}

/** Source pieces are original text, never generated intermediate prose. */
export function uniqueSources(sources: SourcePiece[]): SourcePiece[] {
  return [...new Map(sources.map(source => [`${source.ref}:${source.part}`, source])).values()]
    .sort((a, b) => a.ref - b.ref || a.part - b.part);
}
