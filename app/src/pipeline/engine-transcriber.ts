import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/protocol.js";
import type { PipelineStages } from "./pipeline.js";

export interface EngineTranscriberOptions {
  /** The WhisperKit variant to use. */
  model: string;
  /** Where the engine keeps downloaded models. */
  modelsDirectory: string;
}

/** The transcription stage: asks the engine to transcribe a Recording's tracks and waits for its answer. */
export function createEngineTranscriber(engine: Engine, options: EngineTranscriberOptions): PipelineStages["transcribe"] {
  const pending = new Map<string, { resolve: (t: Awaited<ReturnType<PipelineStages["transcribe"]>>) => void; reject: (e: Error) => void }>();

  engine.onEvent((event) => {
    if (event.type !== "transcript_ready" && event.type !== "transcription_failed") return;
    const waiting = pending.get(event.id);
    if (!waiting) return;
    pending.delete(event.id);
    if (event.type === "transcript_ready") waiting.resolve({ segments: event.segments });
    else waiting.reject(new Error(event.message));
  });

  engine.onExit(() => {
    for (const waiting of pending.values()) waiting.reject(new Error("the engine stopped while transcribing"));
    pending.clear();
  });

  return (tracks) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      engine.send({ type: "transcribe", id, ...tracks, ...options });
    });
}
