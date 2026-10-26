import type { PipelineStages, Summary, Transcript } from "../pipeline/pipeline.js";

export const fixtureTranscript: Transcript = {
  segments: [
    { start: 0, end: 3.2, speaker: "You", text: "Let's ship the walking skeleton first." },
    { start: 3.5, end: 6, speaker: "Speaker 1", text: "Agreed, then fan out to detection and the window." },
  ],
};

export const fixtureSummary: Summary = {
  tldr: "Ship the walking skeleton first, then fan out.",
  participants: [
    { speaker: "You", said: ["Ship the walking skeleton first."] },
    { speaker: "Speaker 1", said: ["Fan out to detection and the window afterwards."] },
  ],
};

/** Deterministic stand-in for the real pipeline. Either stage can be told to fail. */
export function fakePipeline(opts: { failTranscribe?: string; failSummarise?: string; silent?: boolean } = {}): PipelineStages {
  return {
    async transcribe() {
      if (opts.failTranscribe) throw new Error(opts.failTranscribe);
      return opts.silent ? { segments: [] } : fixtureTranscript;
    },
    async summarise() {
      if (opts.failSummarise) throw new Error(opts.failSummarise);
      return fixtureSummary;
    },
  };
}
