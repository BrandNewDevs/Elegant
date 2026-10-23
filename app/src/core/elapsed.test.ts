import { describe, expect, it } from "vitest";
import { formatElapsed } from "./elapsed.js";

describe("formatElapsed", () => {
  const startedAt = "2026-10-24T10:00:00.000Z";
  const after = (ms: number) => new Date(Date.parse(startedAt) + ms);

  it("shows minutes and seconds under an hour", () => {
    expect(formatElapsed(startedAt, after(0))).toBe("0:00");
    expect(formatElapsed(startedAt, after(59_999))).toBe("0:59");
    expect(formatElapsed(startedAt, after(61_000))).toBe("1:01");
    expect(formatElapsed(startedAt, after(59 * 60_000 + 59_000))).toBe("59:59");
  });

  it("shows hours from an hour on", () => {
    expect(formatElapsed(startedAt, after(3_600_000))).toBe("1:00:00");
    expect(formatElapsed(startedAt, after(2 * 3_600_000 + 5 * 60_000 + 7_000))).toBe("2:05:07");
  });

  it("never goes negative if the clocks disagree", () => {
    expect(formatElapsed(startedAt, after(-5_000))).toBe("0:00");
  });
});
