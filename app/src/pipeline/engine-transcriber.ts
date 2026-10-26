import { randomUUID } from "node:crypto";
import type { Engine } from "../engine/protocol.js";
import type { PipelineStages, Transcript } from "./pipeline.js";

export interface EngineTranscriberOptions {
  /** The WhisperKit variant to use. */
  model: string;
  /** Where the engine keeps downloaded models. */
  modelsDirectory: string;
  /** A hung unload must not hold the AI queue forever. */
  releaseTimeoutMs?: number;
}

/** Waits for both the Transcript and acknowledged speech-model release before text generation can start. */
export function createEngineTranscriber(engine: Engine, options: EngineTranscriberOptions): PipelineStages["transcribe"] {
  const { model, modelsDirectory, releaseTimeoutMs = 30_000 } = options;
  interface Pending {
    resolve: (transcript: Transcript) => void;
    reject: (error: Error) => void;
    transcript?: Transcript;
    releaseId?: string;
    timer?: ReturnType<typeof setTimeout>;
  }
  const pending = new Map<string, Pending>();
  const releasing = new Map<string, string>();

  function finish(id: string, error?: Error): void {
    const waiting = pending.get(id);
    if (!waiting) return;
    pending.delete(id);
    if (waiting.releaseId) releasing.delete(waiting.releaseId);
    if (waiting.timer) clearTimeout(waiting.timer);
    if (error) waiting.reject(error);
    else if (waiting.transcript) waiting.resolve(waiting.transcript);
  }

  engine.onEvent((event) => {
    if (event.type === "models_released" || event.type === "model_release_failed") {
      const id = releasing.get(event.id);
      if (!id) return;
      finish(id, event.type === "model_release_failed" ? new Error(`speech models could not be released: ${event.message}`) : undefined);
      return;
    }
    if (event.type !== "transcript_ready" && event.type !== "transcription_failed") return;
    const waiting = pending.get(event.id);
    if (!waiting || waiting.releaseId) return;
    if (event.type === "transcription_failed") {
      finish(event.id, new Error(event.message));
      return;
    }
    waiting.transcript = { segments: event.segments };
    waiting.releaseId = randomUUID();
    releasing.set(waiting.releaseId, event.id);
    waiting.timer = setTimeout(() => finish(event.id, new Error("the engine did not confirm speech-model release; restart the app and retry")), releaseTimeoutMs);
    waiting.timer.unref?.();
    try {
      engine.send({ type: "release_models", id: waiting.releaseId });
    } catch {
      finish(event.id, new Error("the engine could not be asked to release speech models"));
    }
  });

  engine.onExit(() => {
    for (const id of pending.keys()) finish(id, new Error("the engine stopped while transcribing or releasing speech models"));
  });

  return (tracks) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      pending.set(id, { resolve, reject });
      try {
        engine.send({ type: "transcribe", id, ...tracks, model, modelsDirectory });
      } catch {
        finish(id, new Error("the engine could not be asked to transcribe"));
      }
    });
}
