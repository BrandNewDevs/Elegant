import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KNOWN_CALL_APPS } from "./detection.js";

/**
 * The editable list of apps whose use of the microphone counts as a Meeting, kept as `{ "knownApps": ["zoom.us", ...] }`.
 * The file is created with the defaults when it is missing and read again on every call, so an app added to it is
 * detected without a restart. A file that cannot be read keeps the last good list rather than turning Detection off.
 */
export function knownAppsFile(path: string): () => readonly string[] {
  let current: readonly string[] = KNOWN_CALL_APPS;
  try {
    readFileSync(path);
  } catch {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ knownApps: KNOWN_CALL_APPS }, null, 2)}\n`);
  }
  return () => {
    try {
      current = parseKnownApps(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`[known apps] ignoring ${path}: ${(err as Error).message}`);
    }
    return current;
  };
}

function parseKnownApps(text: string): string[] {
  const apps = (JSON.parse(text) as { knownApps?: unknown }).knownApps;
  if (!Array.isArray(apps) || !apps.every((a) => typeof a === "string")) {
    throw new Error('expected { "knownApps": ["App name", ...] }');
  }
  return apps;
}
