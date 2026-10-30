import type { EngineStatus } from "../core/app-core.js";

export const STATUS_LABEL: Record<EngineStatus, { symbol: string; text: string }> = {
  starting: { symbol: "◌", text: "Engine starting…" },
  running: { symbol: "●", text: "Engine running" },
  stopped: { symbol: "○", text: "Engine stopped" },
  crashed: { symbol: "⚠︎", text: "Engine stopped unexpectedly" },
};

/**
 * What the menu-bar item shows next to the app's icon: the elapsed time while recording, nothing while the engine is running
 * as it should (the icon says it), and the status symbol when it is not.
 */
export function trayTitle(status: EngineStatus, recording?: { symbol: string; elapsed: string }): string {
  if (recording) return `${recording.symbol} ${recording.elapsed}`;
  return status === "running" ? "" : STATUS_LABEL[status].symbol;
}
