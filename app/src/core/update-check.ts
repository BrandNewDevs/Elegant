/** A published release newer than the running app. */
export interface UpdateNotice {
  /** The version without its leading `v`, for example `0.2.0`. */
  version: string;
  /** The release page on github.com. */
  url: string;
}

export interface UpdateCheckOptions {
  /** The running app's version, as in package.json. */
  currentVersion: string;
  /** `owner/name` of the GitHub repository. */
  repo: string;
  /** Sent as the User-Agent, which the GitHub API requires: the display name and version. */
  userAgent: string;
  fetch: typeof fetch;
  /** Whether the person allows the check; asked before the request and again once it has answered. */
  enabled: () => boolean;
  /** The last version the person was told about, so the same release is not announced twice. */
  lastNotified: () => string | undefined;
  /** How long to wait for GitHub before giving up. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

interface Semver {
  core: number[];
  prerelease: string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parse(version: string): Semver | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

/** Semver precedence: negative when `a` is older than `b`, positive when newer, 0 when equal; undefined if either is not a version. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return undefined;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i]! < right.core[i]! ? -1 : 1;
  }
  // A version with a pre-release part comes before the same version without one.
  if (!left.prerelease.length || !right.prerelease.length) return right.prerelease.length - left.prerelease.length;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i];
    const y = right.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) < Number(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether `url` is an https page on github.com, the only kind the app opens in the browser. */
export function isGithubUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}

/**
 * Asks GitHub for the repository's latest published release (never a draft or a pre-release) and returns it when it is newer
 * than the running app and the person has not been told about it yet. A plain GET that sends nothing about the person; every
 * failure, an offline Mac included, is silent and gives undefined. It downloads and installs nothing.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateNotice | undefined> {
  if (!options.enabled()) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let release: unknown;
  try {
    const response = await options.fetch(`https://api.github.com/repos/${options.repo}/releases/latest`, {
      headers: { "User-Agent": options.userAgent, Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    release = await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  if (!options.enabled() || !release || typeof release !== "object") return undefined;
  const { tag_name, html_url, draft, prerelease } = release as Record<string, unknown>;
  if (draft !== false || prerelease !== false || typeof tag_name !== "string" || !isGithubUrl(html_url)) return undefined;
  const version = tag_name.replace(/^v/, "");
  if ((compareVersions(version, options.currentVersion) ?? 0) <= 0) return undefined;
  if (version === options.lastNotified()) return undefined;
  return { version, url: html_url };
}
