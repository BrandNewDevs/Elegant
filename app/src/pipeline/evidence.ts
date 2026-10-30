import { createHash } from "node:crypto";
import type { Transcript, TranscriptSegment } from "./pipeline.js";

/** Original Transcript text split for bounded evidence requests; references remain segment ordinals. */
export interface SourceFragment {
  id: string;
  ref: number;
  part: number;
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface SummaryEvidence {
  revision: string;
  tldr: number[];
  participants: { speaker: string; said: number[][] }[];
}
export interface SummaryGeneration {
  /** Missing on legacy local results. */
  provider?: "ollama" | "gemini";
  fallbacks?: number;
  requests?: { stage: string; bytes: number; attempt: number; elapsedMs: number }[];
  promptVersion: string;
  model: string;
  elapsedMs: number;
  calls: number;
  promptTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
}
export interface TranscriptReference { revision: string; refs: number[] }

/** Hash content in wire order. Display names and database IDs never affect evidence identity. */
export function transcriptRevision(transcript: Transcript): string {
  return createHash("sha256").update(JSON.stringify(transcript.segments.map(s => [s.start, s.end, s.speaker, s.text]))).digest("hex");
}

export function resolveReference(transcript: Transcript, reference: TranscriptReference): { ref: number; segment: TranscriptSegment }[] {
  if (reference.revision !== transcriptRevision(transcript)) throw new Error("This reference belongs to an older Transcript");
  if (!reference.refs.length || new Set(reference.refs).size !== reference.refs.length) throw new Error("Evidence needs distinct source segments");
  return reference.refs.map(ref => {
    if (!Number.isInteger(ref) || ref < 0 || ref >= transcript.segments.length) throw new Error("Unknown Transcript reference");
    return { ref, segment: transcript.segments[ref]! };
  });
}

export function evidenceLines(transcript: Transcript, refs = transcript.segments.map((_, i) => i)): string {
  return refs.map(ref => {
    const s = transcript.segments[ref];
    if (!s) throw new Error("Unknown Transcript reference");
    return JSON.stringify({ ref, start: s.start, end: s.end, speaker: s.speaker, text: s.text });
  }).join("\n");
}
