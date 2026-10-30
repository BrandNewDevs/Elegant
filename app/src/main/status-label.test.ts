import { expect, it } from "vitest";
import { STATUS_LABEL, trayTitle } from "./status-label.js";

it("shows only the elapsed time while recording, whatever the engine status", () => {
  expect(trayTitle("running", { symbol: "⏺", elapsed: "02:15" })).toBe("⏺ 02:15");
  expect(trayTitle("crashed", { symbol: "⏺", elapsed: "02:15" })).toBe("⏺ 02:15");
});

it("shows nothing beside the icon while the engine runs, and the status symbol when it does not", () => {
  expect(trayTitle("running")).toBe("");
  for (const status of ["starting", "stopped", "crashed"] as const) expect(trayTitle(status)).toBe(STATUS_LABEL[status].symbol);
});
