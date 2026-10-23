import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { until } from "../testing/until.js";
import { ProcessEngine } from "./process-engine.js";
import type { EngineEvent, EngineExit } from "./protocol.js";

const stub = fileURLToPath(new URL("../testing/stub-engine.mjs", import.meta.url));

function watch(engine: ProcessEngine) {
  const events: EngineEvent[] = [];
  const exits: EngineExit[] = [];
  engine.onEvent((e) => events.push(e));
  engine.onExit((x) => exits.push(x));
  return { events, exits };
}

describe("ProcessEngine", () => {
  it("turns the engine's JSON lines into events, even when a line arrives in pieces", async () => {
    const engine = new ProcessEngine({ command: process.execPath, args: [stub] });
    const { events } = watch(engine);
    engine.start();
    await until(() => events.length >= 4);

    expect(events[0]).toEqual({ type: "ready", version: "9.9.9" });
    expect(events[2]).toEqual({ type: "error", message: "boom" });
    expect(events[3]).toEqual({ type: "mic_in_use_started", app: "zoom.us", pid: 42 });
    await engine.stop();
  });

  it("reports a line that is not valid protocol as an error event instead of throwing", async () => {
    const engine = new ProcessEngine({ command: process.execPath, args: [stub] });
    const { events } = watch(engine);
    engine.start();
    await until(() => events.length >= 2);

    expect(events[1]).toMatchObject({ type: "error", message: expect.stringContaining("not json") });
    await engine.stop();
  });

  it("sends commands as JSON lines", async () => {
    const engine = new ProcessEngine({ command: process.execPath, args: [stub] });
    const { events } = watch(engine);
    engine.start();
    await until(() => events.length >= 4);

    engine.send({ type: "stop_recording" });
    await until(() => events.length >= 5);
    expect(events[4]).toMatchObject({ type: "recording_started", app: "echo:stop_recording" });
    await engine.stop();
  });

  it("stop() asks the engine to shut down and resolves once it has exited", async () => {
    const engine = new ProcessEngine({ command: process.execPath, args: [stub] });
    const { exits } = watch(engine);
    engine.start();
    await engine.stop();
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });

  it("kills an engine that ignores the shutdown command", async () => {
    const engine = new ProcessEngine({ command: process.execPath, args: [stub, "stubborn"], killAfterMs: 100 });
    const { exits } = watch(engine);
    engine.start();
    await engine.stop();
    expect(exits).toEqual([{ code: null, signal: "SIGKILL" }]);
  });

  it("reports an exit when the engine cannot be launched at all", async () => {
    const engine = new ProcessEngine({ command: "/nonexistent/engine" });
    const { events, exits } = watch(engine);
    engine.start();
    await until(() => exits.length > 0);

    expect(events).toContainEqual({ type: "error", message: expect.stringContaining("/nonexistent/engine") });
    expect(exits).toHaveLength(1);
  });
});
