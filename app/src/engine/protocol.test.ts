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
