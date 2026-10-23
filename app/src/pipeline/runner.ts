import type { Store } from "../store/store.js";
import type { PipelineStages, Tracks } from "./pipeline.js";

/** What the runner needs from the store, so it does not depend on the whole thing. */
export type PipelineSink = Pick<Store, "saveTranscript" | "saveSummary" | "setMeetingState">;

/** Runs a Meeting's Recording through the stages in order and records the outcome. */
export class PipelineRunner {
  constructor(
    private readonly stages: PipelineStages,
    private readonly sink: PipelineSink,
  ) {}

  async run(meetingId: number, tracks: Tracks): Promise<void> {
    this.sink.setMeetingState(meetingId, "processing");
    try {
      const transcript = await this.stages.transcribe(tracks);
      this.sink.saveTranscript(meetingId, transcript);
      const summary = await this.stages.summarise(transcript);
      this.sink.saveSummary(meetingId, summary);
      this.sink.setMeetingState(meetingId, "done");
    } catch (err) {
      this.sink.setMeetingState(meetingId, "failed", err instanceof Error ? err.message : String(err));
    }
  }
}
