import type { Store } from "../store/store.js";
import type { PipelineStages, Tracks, Transcript } from "./pipeline.js";

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
      await this.summarise(meetingId, transcript);
    } catch (err) {
      this.fail(meetingId, err);
    }
  }

  /** Summarises an already stored Transcript, for retrying a Meeting that failed at that stage. */
  async resummarise(meetingId: number, transcript: Transcript): Promise<void> {
    this.sink.setMeetingState(meetingId, "processing");
    try {
      await this.summarise(meetingId, transcript);
    } catch (err) {
      this.fail(meetingId, err);
    }
  }

  private async summarise(meetingId: number, transcript: Transcript): Promise<void> {
    const summary = await this.stages.summarise(transcript);
    this.sink.saveSummary(meetingId, summary);
    this.sink.setMeetingState(meetingId, "done");
  }

  private fail(meetingId: number, err: unknown): void {
    this.sink.setMeetingState(meetingId, "failed", err instanceof Error ? err.message : String(err));
  }
}
