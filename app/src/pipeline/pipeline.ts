import type { SummaryEvidence, SummaryGeneration } from "./evidence.js";
// The two pipeline stages and their JSON contract. See docs/ai-brief.md.

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
}

export interface Summary {
  tldr: string;
  evidence?: SummaryEvidence;
  generation?: SummaryGeneration;
  participants: { speaker: string; said: string[] }[];
}

export interface Tracks {
  micPath: string;
  systemPath: string;
}

export interface PipelineContext {
  signal?: AbortSignal;
  /** The Transcript is saved before the summarising stage is announced. */
  onStage?: (stage: "transcribing" | "summarising") => void;
}

export interface PipelineStages {
  transcribe(tracks: Tracks, context?: PipelineContext): Promise<Transcript>;
  summarise(transcript: Transcript, context?: PipelineContext): Promise<Summary>;
}
