import { describe, expect, it } from "vitest";
import { promptPosition } from "./prompt-position.js";

const size = { width: 340, height: 96 };

describe("the Prompt's position", () => {
  it("is centred horizontally at the bottom of the usable area", () => {
    expect(promptPosition({ x: 0, y: 0, width: 1440, height: 875 }, size)).toEqual({ x: 550, y: 755 });
  });

  it("follows a display that does not start at the origin, such as a second monitor", () => {
    expect(promptPosition({ x: 1709, y: 1080, width: 1920, height: 1055 }, size)).toEqual({ x: 2499, y: 2015 });
  });

  it("rounds to whole pixels", () => {
    const { x, y } = promptPosition({ x: 0, y: 0, width: 1001, height: 700 }, size);
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
  });
});
