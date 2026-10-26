import { describe, expect, it } from "vitest";
import { parseEngineEvent } from "./protocol.js";

describe("parsing a transcript_ready event", () => {
  const line = (segments: unknown) => JSON.stringify({ type: "transcript_ready", id: "1", segments });

  it("accepts segments in the documented shape, and none at all", () => {
    const segments = [{ start: 0, end: 1.5, speaker: "You", text: "hi" }];
    expect(parseEngineEvent(line(segments))).toEqual({ type: "transcript_ready", id: "1", segments });
    expect(parseEngineEvent(line([]))).toMatchObject({ segments: [] });
  });

  it("rejects segments that are missing, or have a wrong or missing field", () => {
    expect(() => parseEngineEvent(JSON.stringify({ type: "transcript_ready", id: "1" }))).toThrow(/segments/);
    expect(() => parseEngineEvent(line([{ start: 0, end: 1, speaker: "You" }]))).toThrow(/malformed segment at index 0/);
    expect(() => parseEngineEvent(line([{ start: "0", end: 1, speaker: "You", text: "x" }]))).toThrow(/malformed segment/);
    expect(() => parseEngineEvent(line([null]))).toThrow(/malformed segment/);
  });
});

describe("parsing first-run setup events", () => {
  it("accepts a permission answer, progress and the end of a download", () => {
    expect(parseEngineEvent(JSON.stringify({ type: "permission_result", permission: "microphone", granted: false }))).toMatchObject({ granted: false });
    expect(parseEngineEvent(JSON.stringify({ type: "model_download_progress", model: "m", fraction: 0.5 }))).toMatchObject({ fraction: 0.5 });
    expect(parseEngineEvent(JSON.stringify({ type: "models_ready" }))).toEqual({ type: "models_ready" });
  });

  it("rejects a permission answer whose granted is not a boolean", () => {
    expect(() => parseEngineEvent(JSON.stringify({ type: "permission_result", permission: "microphone", granted: "yes" }))).toThrow(/granted/);
  });
});
