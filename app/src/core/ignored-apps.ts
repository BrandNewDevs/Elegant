import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Extra apps to ignore for Detection, kept as `{ "ignoredApps": ["Some App", ...] }`. The file is created empty when
 * missing. Built-in ignores (Siri, Dictation) always apply. It is read again on every microphone event, so an edit
 * applies at once. A file that cannot be read keeps the last good list rather than turning Detection off.
 */
export function ignoredAppsFile(path: string): () => readonly string[] {
  let current: readonly string[] = [];
  try {
    readFileSync(path);
  } catch {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ignoredApps: [] }, null, 2)}\n`);
  }
  return () => {
    try {
      current = parseIgnoredApps(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`[ignored apps] ignoring ${path}: ${(err as Error).message}`);
    }
    return current;
  };
}

function parseIgnoredApps(text: string): string[] {
  const apps = (JSON.parse(text) as { ignoredApps?: unknown }).ignoredApps;
  if (!Array.isArray(apps) || !apps.every((a) => typeof a === "string")) {
    throw new Error('expected { "ignoredApps": ["App name", ...] }');
  }
  return apps;
}
