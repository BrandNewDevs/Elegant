import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const mainDir = dirname(fileURLToPath(import.meta.url));

export type RendererPage = "meetings" | "onboarding" | "settings" | "prompt";

export function rendererPagePath(page: RendererPage): string {
  return join(mainDir, "../renderer", `${page}.html`);
}

export function preloadPath(): string {
  return join(mainDir, "../preload/preload.cjs");
}
