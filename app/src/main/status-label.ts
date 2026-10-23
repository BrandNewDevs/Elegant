import type { EngineStatus } from "../core/app-core.js";

export const STATUS_LABEL: Record<EngineStatus, { symbol: string; text: string }> = {
  starting: { symbol: "◌", text: "Engine starting…" },
  running: { symbol: "●", text: "Engine running" },
  stopped: { symbol: "○", text: "Engine stopped" },
  crashed: { symbol: "⚠︎", text: "Engine stopped unexpectedly" },
};
