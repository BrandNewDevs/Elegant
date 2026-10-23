// The wire protocol between the Swift engine and the app: one JSON object per line over stdio.

/** Events the engine sends up to the app. */
export type EngineEvent =
  | { type: "ready"; version: string }
  | { type: "mic_in_use_started"; app: string; pid: number }
  | { type: "mic_in_use_stopped"; app: string; pid: number }
  | { type: "recording_started"; app: string; startedAt: string }
  | { type: "tracks_ready"; micPath: string; systemPath: string }
  | { type: "error"; message: string };

/** Commands the app sends down to the engine. */
export type EngineCommand =
  | { type: "start_recording" }
  | { type: "discard_buffer" }
  | { type: "stop_recording" }
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

const EVENT_FIELDS: Record<EngineEvent["type"], Record<string, "string" | "number">> = {
  ready: { version: "string" },
  mic_in_use_started: { app: "string", pid: "number" },
  mic_in_use_stopped: { app: "string", pid: "number" },
  recording_started: { app: "string", startedAt: "string" },
  tracks_ready: { micPath: "string", systemPath: "string" },
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
    if (typeof obj[name] !== kind) throw new Error(`engine event "${obj.type}" is missing ${kind} field "${name}"`);
  }
  return obj as EngineEvent;
}

export function encodeCommand(command: EngineCommand): string {
  return JSON.stringify(command) + "\n";
}
