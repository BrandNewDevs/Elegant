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
  participants: { speaker: string; said: string[] }[];
}

export interface Tracks {
  micPath: string;
  systemPath: string;
}

export interface PipelineContext { signal?: AbortSignal }

export interface PipelineStages {
  transcribe(tracks: Tracks, context?: PipelineContext): Promise<Transcript>;
  summarise(transcript: Transcript, context?: PipelineContext): Promise<Summary>;
}
