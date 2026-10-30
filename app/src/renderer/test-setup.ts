import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi, type MockInstance } from "vitest";

let timers: MockInstance<typeof globalThis.setTimeout>;
beforeEach(() => { timers = vi.spyOn(globalThis, "setTimeout"); });
afterEach(() => {
  cleanup();
  // Toast exit animations can outlive unmount; never let them update a destroyed window.
  for (const result of timers.mock.results) {
    if (result.type === "return") clearTimeout(result.value);
  }
  timers.mockRestore();
});
