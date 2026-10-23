import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { until } from "../testing/until.js";
import { ProcessEngine } from "./process-engine.js";
import type { EngineEvent, EngineExit } from "./protocol.js";

// Built by `pnpm run build:engine`, which `pnpm test` runs first.
const engineBinary = fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

describe("the real Swift engine", () => {
  it("reports ready, refuses to stop a recording that never started, and exits on shutdown", async () => {
    expect(existsSync(engineBinary), `engine not built; run: pnpm run build:engine`).toBe(true);

    const engine = new ProcessEngine({ command: engineBinary });
    const events: EngineEvent[] = [];
    const exits: EngineExit[] = [];
    engine.onEvent((e) => events.push(e));
    engine.onExit((x) => exits.push(x));
    engine.start();

    await until(() => events.length >= 1);
    expect(events[0]).toEqual({ type: "ready", version: "0.1.0" });

    engine.send({ type: "stop_recording" });
    await until(() => events.length >= 2);
    expect(events[1]).toMatchObject({ type: "error", message: expect.stringContaining("no recording is in progress") });

    await engine.stop();
    expect(exits).toEqual([{ code: 0, signal: null }]);
  });
});
