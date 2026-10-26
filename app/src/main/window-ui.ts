import { nativeTheme } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainDir = dirname(fileURLToPath(import.meta.url));

export type RendererPage = "meetings" | "onboarding" | "prompt";

export function rendererPagePath(page: RendererPage): string {
  return join(mainDir, "../renderer", `${page}.html`);
}

export function preloadPath(): string {
  return join(mainDir, "../preload/preload.cjs");
}

/** The page background (`--background` in the renderer's theme), so a window is not white for a moment in dark mode. */
export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#09090b" : "#ffffff";
}
