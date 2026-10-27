import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, compareVersions, isGithubUrl, type UpdateCheckOptions } from "./update-check.js";

const release = (patch: Record<string, unknown> = {}) => ({
  tag_name: "v0.2.0",
  html_url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0",
  draft: false,
  prerelease: false,
  ...patch,
});

function options(body: unknown, patch: Partial<UpdateCheckOptions> = {}, status = 200) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  return {
    fetch,
    options: {
      currentVersion: "0.1.2",
      repo: "BrandNewDevs/Elegant",
      userAgent: "Elegant/0.1.2",
      fetch: fetch as unknown as typeof globalThis.fetch,
      enabled: () => true,
      lastNotified: () => undefined,
      ...patch,
    } satisfies UpdateCheckOptions,
  };
}

afterEach(() => vi.useRealTimers());

describe("compareVersions", () => {
  it("compares numbers, not text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.2", "0.1.10")).toBeLessThan(0);
    expect(compareVersions("v0.1.2", "0.1.2")).toBe(0);
  });

  it("puts a pre-release before its release and orders pre-releases by the semver rules", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-alpha")).toBeGreaterThan(0);
  });

  it("ignores build metadata and rejects what is not a version", () => {
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("latest", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0", "1.0.0")).toBeUndefined();
    expect(compareVersions("1.0.0", "")).toBeUndefined();
  });
});

describe("isGithubUrl", () => {
  it("accepts only https pages on github.com", () => {
    expect(isGithubUrl("https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0")).toBe(true);
    for (const url of ["http://github.com/x", "https://github.com.evil.example/x", "https://evil.example/https://github.com/", "https://user@github.com/x", "https://github.com:8443/x", "file:///etc/passwd", "javascript:alert(1)", "github.com", 5, undefined]) {
      expect(isGithubUrl(url)).toBe(false);
    }
  });
});

describe("checkForUpdate", () => {
  it("returns a newer release, from a plain GET that identifies only the app", async () => {
    const { fetch, options: o } = options(release());
    expect(await checkForUpdate(o)).toEqual({ version: "0.2.0", url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/BrandNewDevs/Elegant/releases/latest");
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ "User-Agent": "Elegant/0.1.2", Accept: "application/vnd.github+json" });
  });

  it("says nothing for the same version or an older one", async () => {
    expect(await checkForUpdate(options(release({ tag_name: "v0.1.2" })).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ tag_name: "v0.1.1" })).options)).toBeUndefined();
  });

  it("ignores a draft or a pre-release", async () => {
    expect(await checkForUpdate(options(release({ draft: true })).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ prerelease: true })).options)).toBeUndefined();
  });

  it("ignores a response that is not a release", async () => {
    expect(await checkForUpdate(options("{not json").options)).toBeUndefined();
    expect(await checkForUpdate(options(null).options)).toBeUndefined();
    expect(await checkForUpdate(options([release()]).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ tag_name: "nightly" })).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ tag_name: 2 })).options)).toBeUndefined();
    expect(await checkForUpdate(options({ tag_name: "v0.2.0", html_url: "https://github.com/x" }).options)).toBeUndefined();
  });

  it("ignores a release page that is not on github.com", async () => {
    expect(await checkForUpdate(options(release({ html_url: "https://evil.example/Elegant" })).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ html_url: "javascript:alert(1)" })).options)).toBeUndefined();
  });

  it("is silent on an HTTP error, a network error and an unreadable current version", async () => {
    expect(await checkForUpdate(options(release(), {}, 403).options)).toBeUndefined();
    expect(await checkForUpdate(options(release(), {}, 404).options)).toBeUndefined();
    const offline = options(release(), { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    expect(await checkForUpdate(offline.options)).toBeUndefined();
    expect(await checkForUpdate(options(release(), { currentVersion: "dev" }).options)).toBeUndefined();
  });

  it("gives up when GitHub does not answer in time", async () => {
    vi.useFakeTimers();
    const hanging = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
    const result = checkForUpdate(options(release(), { fetch: hanging, timeoutMs: 3000 }).options);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toBeUndefined();
  });

  it("makes no request while the setting is off, and drops an answer that arrives after it was turned off", async () => {
    let enabled = false;
    const off = options(release(), { enabled: () => enabled });
    expect(await checkForUpdate(off.options)).toBeUndefined();
    expect(off.fetch).not.toHaveBeenCalled();

    enabled = true;
    const turnedOff = options(release(), {
      enabled: () => enabled,
      fetch: (async () => { enabled = false; return new Response(JSON.stringify(release())); }) as typeof fetch,
    });
    expect(await checkForUpdate(turnedOff.options)).toBeUndefined();
  });

  it("does not announce a version the person was already told about, but does announce a newer one", async () => {
    expect(await checkForUpdate(options(release(), { lastNotified: () => "0.2.0" }).options)).toBeUndefined();
    expect(await checkForUpdate(options(release({ tag_name: "v0.3.0" }), { lastNotified: () => "0.2.0" }).options)).toMatchObject({ version: "0.3.0" });
  });
});
