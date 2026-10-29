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

/** The page of a release on github.com, where the person can download it by hand. */
export function releasePageUrl(repo: string, version: string): string {
  return `https://github.com/${repo}/releases/tag/v${version}`;
}

/**
 * Whether a release feed (`latest-mac.yml`) is acceptable: every file is a bare file name, which electron-updater resolves
 * inside the release's own download folder on github.com (a scheme, host or path could point anywhere else), and carries
 * the sha512 the download is checked against.
 */
export function isAcceptableFeed(files: readonly { url?: unknown; sha512?: unknown }[]): boolean {
  return files.length > 0 && files.every(({ url, sha512 }) =>
    typeof url === "string" && /^[A-Za-z0-9._-]+$/.test(url) && typeof sha512 === "string" && sha512.length > 0);
}
