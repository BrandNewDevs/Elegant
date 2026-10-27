import { rm, rmdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Store } from "../store/store.js";
import type { PipelineContext, PipelineStages, Tracks, Transcript } from "./pipeline.js";

/** What the runner needs from the store, so it does not depend on the whole thing. */
export type PipelineSink = Pick<Store, "saveTranscript" | "saveSummary" | "setMeetingState" | "saveAudio" | "clearAudio">;

/** The engine puts each Recording's tracks in a directory of its own with this prefix; only such a directory is removed. */
const RECORDING_DIR_PREFIX = "elegant-";

/** Runs a Meeting's Recording through the stages in order and records the outcome. */
export class PipelineRunner {
  constructor(
    private readonly stages: PipelineStages,
    private readonly sink: PipelineSink,
    /** Asked after each transcription, so changing the setting applies to the next Recording without a restart. */
    private readonly options: { keepAudio?: () => boolean } = {},
  ) {}

  /** Transcribes and summarises a Recording. Also the retry for a Meeting whose transcription failed: its audio is still there. */
  async run(meetingId: number, tracks: Tracks, context: PipelineContext = {}): Promise<void> {
    this.sink.setMeetingState(meetingId, "processing");
    // Remembered until the audio is deleted, so a failure can be retried without re-recording.
    this.sink.saveAudio(meetingId, tracks);
    try {
      this.stage(context, "transcribing");
      const transcript = await this.stages.transcribe(tracks, context);
      context.signal?.throwIfAborted();
      this.sink.saveTranscript(meetingId, transcript);
      if (transcript.segments.length) this.stage(context, "summarising");
      if (!this.options.keepAudio?.()) {
        await discardAudio(tracks);
        this.sink.clearAudio(meetingId);
      }
      // A call with no speech is a finished Meeting with nothing to summarise, not a failure.
      if (transcript.segments.length === 0) this.sink.setMeetingState(meetingId, "done");
      else await this.summarise(meetingId, transcript, context);
    } catch (err) {
      this.fail(meetingId, err);
    }
  }

  /** Summarises an already stored Transcript, for retrying a Meeting that failed at that stage. */
  async resummarise(meetingId: number, transcript: Transcript, context: PipelineContext = {}): Promise<void> {
    this.sink.setMeetingState(meetingId, "processing");
    try {
      await this.summarise(meetingId, transcript, context);
    } catch (err) {
      this.fail(meetingId, err);
    }
  }

  private async summarise(meetingId: number, transcript: Transcript, context: PipelineContext): Promise<void> {
    this.stage(context, "summarising");
    const summary = await this.stages.summarise(transcript, context);
    context.signal?.throwIfAborted();
    this.sink.saveSummary(meetingId, summary);
    this.sink.setMeetingState(meetingId, "done");
  }

  private stage(context: PipelineContext, stage: "transcribing" | "summarising"): void {
    try { context.onStage?.(stage); } catch { /* A progress observer cannot prevent persistence. */ }
  }

  private fail(meetingId: number, err: unknown): void {
    this.sink.setMeetingState(meetingId, "failed", err instanceof Error ? err.message : String(err));
  }
}

/** Deletes a Recording's tracks, and their directory if the engine made it and nothing else is in it. */
export async function discardAudio(tracks: Tracks): Promise<void> {
  for (const path of [tracks.micPath, tracks.systemPath]) await rm(path, { force: true });
  const dir = dirname(tracks.micPath);
  if (!basename(dir).startsWith(RECORDING_DIR_PREFIX)) return;
  try {
    await rmdir(dir);
  } catch {
    // Not empty, or already gone; either way there is nothing more to clean up.
  }
}
