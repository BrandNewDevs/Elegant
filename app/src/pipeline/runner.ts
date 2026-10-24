import { rm, rmdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Store } from "../store/store.js";
import type { PipelineStages, Tracks, Transcript } from "./pipeline.js";

/** What the runner needs from the store, so it does not depend on the whole thing. */
export type PipelineSink = Pick<Store, "saveTranscript" | "saveSummary" | "setMeetingState">;

/** The engine puts each Recording's tracks in a directory of its own with this prefix; only such a directory is removed. */
const RECORDING_DIR_PREFIX = "meeting-recorder-";

/** Runs a Meeting's Recording through the stages in order and records the outcome. */
export class PipelineRunner {
  constructor(
    private readonly stages: PipelineStages,
    private readonly sink: PipelineSink,
    private readonly options: { keepAudio?: boolean } = {},
  ) {}

  async run(meetingId: number, tracks: Tracks): Promise<void> {
    this.sink.setMeetingState(meetingId, "processing");
    try {
      const transcript = await this.stages.transcribe(tracks);
      this.sink.saveTranscript(meetingId, transcript);
      if (!this.options.keepAudio) await discardAudio(tracks);
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

/** Deletes a Recording's tracks, and their directory if the engine made it and nothing else is in it. */
async function discardAudio(tracks: Tracks): Promise<void> {
  for (const path of [tracks.micPath, tracks.systemPath]) await rm(path, { force: true });
  const dir = dirname(tracks.micPath);
  if (!basename(dir).startsWith(RECORDING_DIR_PREFIX)) return;
  try {
    await rmdir(dir);
  } catch {
    // Not empty, or already gone; either way there is nothing more to clean up.
  }
}
