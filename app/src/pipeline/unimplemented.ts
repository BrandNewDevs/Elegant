import type { PipelineStages } from "./pipeline.js";

/** Placeholder until the real stages land: a Recording processed with it ends up failed, with a clear reason. */
export const unimplementedPipeline: PipelineStages = {
  async transcribe() {
    throw new Error("transcription is not implemented yet");
  },
  async summarise() {
    throw new Error("summarising is not implemented yet");
  },
};
