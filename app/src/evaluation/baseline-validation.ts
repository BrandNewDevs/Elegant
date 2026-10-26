// Frozen validation from main 1ee9d82; part of the reproducible baseline.
import type { Summary } from "../pipeline/pipeline.js";

/** The Summary shape from docs/ai-brief.md, as a JSON schema for the model's structured output. */
export const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    tldr: { type: "string" },
    participants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker: { type: "string" },
          said: { type: "array", items: { type: "string" } },
        },
        required: ["speaker", "said"],
      },
    },
  },
  required: ["tldr", "participants"],
} as const;

export const TLDR_SCHEMA = {
  type: "object",
  properties: { tldr: { type: "string" } },
  required: ["tldr"],
} as const;

export class InvalidSummaryError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseObject(json: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new InvalidSummaryError("the output is not valid JSON");
  }
  if (!isRecord(value)) throw new InvalidSummaryError("the output is not a JSON object");
  return value;
}

function checkTldr(tldr: unknown): string {
  if (typeof tldr !== "string" || tldr.trim() === "") throw new InvalidSummaryError("tldr must be a non-empty string");
  return tldr;
}

/** Reads the combining step's output: just a tldr. */
export function parseTldr(json: string): string {
  return checkTldr(parseObject(json).tldr);
}

/** Checks model output against the Summary shape and the Transcript's speaker labels. Throws InvalidSummaryError. */
export function parseSummary(json: string, labels: ReadonlySet<string>): Summary {
  const value = parseObject(json);
  const tldr = checkTldr(value.tldr);
  const { participants } = value;
  if (!Array.isArray(participants)) throw new InvalidSummaryError("participants must be a list");

  const seen = new Set<string>();
  const clean: Summary["participants"] = [];
  for (const p of participants) {
    if (!isRecord(p) || typeof p.speaker !== "string") throw new InvalidSummaryError("each participant needs a speaker");
    if (!labels.has(p.speaker)) {
      throw new InvalidSummaryError(`"${p.speaker}" is not a speaker in the Transcript`);
    }
    if (seen.has(p.speaker)) throw new InvalidSummaryError(`"${p.speaker}" appears more than once`);
    seen.add(p.speaker);
    if (!Array.isArray(p.said) || !p.said.every((s) => typeof s === "string")) {
      throw new InvalidSummaryError(`said for "${p.speaker}" must be a list of strings`);
    }
    clean.push({ speaker: p.speaker, said: p.said });
  }
  return { tldr, participants: clean };
}
