// The wire protocol between the Swift engine and the app: one JSON object per line over stdio.
import type { TranscriptSegment } from "../pipeline/pipeline.js";

/** A macOS permission the engine needs. */
export type Permission = "microphone" | "system_audio";

/** Events the engine sends up to the app. */
export type EngineEvent =
  | { type: "ready"; version: string }
  | { type: "mic_in_use_started"; app: string; pid: number }
  | { type: "mic_in_use_stopped"; app: string; pid: number }
  | { type: "recording_started"; app: string; startedAt: string }
  /**
   * Both tracks are already aligned on host time: 16 kHz mono WAV files of equal length, starting at the same
   * instant. The start times are each track's first-sample time on the host clock, in seconds, from before alignment.
   */
  | { type: "tracks_ready"; micPath: string; systemPath: string; micStartHostTime: number; systemStartHostTime: number }
  /** The Transcript for a `transcribe` command, with its segments ordered by start. An empty list means no speech. */
  | { type: "transcript_ready"; id: string; segments: TranscriptSegment[] }
  /** The `transcribe` command with this id failed; the audio is untouched. */
  | { type: "transcription_failed"; id: string; message: string }
  /** Native speech models were unloaded; downloads remain on disk. */
  | { type: "models_released"; id: string }
  | { type: "model_release_failed"; id: string; message: string }
  /** The answer to `request_permission`: whether macOS now lets the engine capture that audio. */
  | { type: "permission_result"; permission: Permission; granted: boolean }
  /** How far a `download_models` command has got, as a fraction from 0 to 1. */
  | { type: "model_download_progress"; model: string; fraction: number }
  /** Every model was downloaded, checked by loading, and released from memory. */
  | { type: "models_ready" }
  /** The `download_models` command failed; models already downloaded are kept. */
  | { type: "model_download_failed"; message: string }
  /** The Recording cannot finish; nothing usable was written. */
  | { type: "recording_failed"; message: string }
  | { type: "error"; message: string };

/** Commands the app sends down to the engine. */
export type EngineCommand =
  /** `app` is the call app being recorded; the engine echoes it back in `recording_started`. */
  | { type: "start_recording"; app: string }
  /**
   * A Detection happened: start holding the last few minutes of both tracks in memory, so that accepting the Prompt
   * late does not lose the start of the Meeting. Nothing is written to disk. `start_recording` keeps the buffer;
   * `discard_buffer` drops it. Ignored if the engine is already buffering or recording.
   */
  | { type: "start_buffer"; app: string }
  /** The Prompt was declined or timed out: drop the buffered audio and stop capturing. Never touches a Recording. */
  | { type: "discard_buffer" }
  | { type: "stop_recording" }
  /**
   * Transcribe a Recording's tracks, in English, on this machine. `model` is a WhisperKit variant name; the engine
   * downloads it into `modelsDirectory` the first time it is needed. Answered by `transcript_ready` or `transcription_failed`.
   */
  | { type: "transcribe"; id: string; micPath: string; systemPath: string; model: string; modelsDirectory: string }
  /**
   * Ask macOS for a permission, which shows its prompt the first time. Answered by `permission_result`; a permission
   * that was already answered is reported without a prompt.
   */
  | { type: "request_permission"; permission: Permission }
  /**
   * Report a permission without asking for it, answered by `permission_result`. The microphone is read from its macOS
   * status and never prompts. System audio has no status, so the engine starts a tap, which prompts if the user never
   * answered: send it only for a permission that was granted before.
   */
  | { type: "check_permission"; permission: Permission }
  /**
   * Download the speech model (and any other model Transcripts need) into `modelsDirectory` and check that it loads, so
   * the first Recording does not wait for it. Answered by `model_download_progress` events, then `models_ready` or
   * `model_download_failed`.
   */
  | { type: "download_models"; model: string; modelsDirectory: string }
  /** Release idle speech models before text generation; answered by models_released or model_release_failed. */
  | { type: "release_models"; id: string }
  | { type: "shutdown" };

export interface EngineExit {
  code: number | null;
  signal: string | null;
}

/** The app's view of the engine. The real one spawns the Swift binary; tests use a scripted fake. */
export interface Engine {
  start(): void;
  send(command: EngineCommand): void;
  onEvent(handler: (event: EngineEvent) => void): void;
  onExit(handler: (exit: EngineExit) => void): void;
  stop(): Promise<void>;
}

const EVENT_FIELDS: Record<EngineEvent["type"], Record<string, "string" | "number" | "boolean" | "array">> = {
  ready: { version: "string" },
  mic_in_use_started: { app: "string", pid: "number" },
  mic_in_use_stopped: { app: "string", pid: "number" },
  recording_started: { app: "string", startedAt: "string" },
  tracks_ready: { micPath: "string", systemPath: "string", micStartHostTime: "number", systemStartHostTime: "number" },
  permission_result: { permission: "string", granted: "boolean" },
  model_download_progress: { model: "string", fraction: "number" },
  models_ready: {},
  model_download_failed: { message: "string" },
  transcript_ready: { id: "string", segments: "array" },
  transcription_failed: { id: "string", message: "string" },
  models_released: { id: "string" },
  model_release_failed: { id: "string", message: "string" },
  recording_failed: { message: "string" },
  error: { message: "string" },
};

/** Parses one line of engine output. Throws an Error describing the problem if it is not a valid event. */
export function parseEngineEvent(line: string): EngineEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`malformed engine output: ${line.slice(0, 200)}`);
  }
  if (typeof value !== "object" || value === null) throw new Error(`malformed engine output: ${line.slice(0, 200)}`);
  const obj = value as Record<string, unknown>;
  const fields = EVENT_FIELDS[obj.type as EngineEvent["type"]];
  if (!fields) throw new Error(`unknown engine event type: ${String(obj.type)}`);
  for (const [name, kind] of Object.entries(fields)) {
    const ok = kind === "array" ? Array.isArray(obj[name]) : typeof obj[name] === kind;
    if (!ok) throw new Error(`engine event "${obj.type}" is missing ${kind} field "${name}"`);
  }
  if (["transcript_ready", "transcription_failed", "models_released", "model_release_failed"].includes(String(obj.type))) {
    if (typeof obj.id !== "string" || obj.id.length === 0 || Buffer.byteLength(obj.id, "utf8") > 128) {
      throw new Error(`engine event "${obj.type}" has an invalid request id`);
    }
  }
  if (obj.type === "transcript_ready") checkSegments(obj.segments as unknown[]);
  return obj as EngineEvent;
}

function checkSegments(segments: unknown[]): void {
  segments.forEach((segment, i) => {
    const s = segment as Partial<Record<keyof TranscriptSegment, unknown>> | null;
    const ok =
      typeof s === "object" && s !== null &&
      typeof s.start === "number" && typeof s.end === "number" &&
      typeof s.speaker === "string" && typeof s.text === "string";
    if (!ok) throw new Error(`engine event "transcript_ready" has a malformed segment at index ${i}`);
  });
}

export function encodeCommand(command: EngineCommand): string {
  return JSON.stringify(command) + "\n";
}
