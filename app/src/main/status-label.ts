import type { EngineStatus } from "../core/app-core.js";

const SYMBOL: Record<EngineStatus, string> = {
  starting: "◌",
  running: "●",
  stopped: "○",
  crashed: "⚠︎",
};

const TEXT: Record<EngineStatus, string> = {
  starting: "Engine starting…",
  running: "Engine running",
  stopped: "Engine stopped",
  crashed: "Engine stopped unexpectedly",
};

export function statusSymbol(status: EngineStatus): string {
  return SYMBOL[status];
}

export function statusText(status: EngineStatus): string {
  return TEXT[status];
}
