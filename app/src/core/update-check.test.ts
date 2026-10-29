import { describe, expect, it } from "vitest";
import { compareVersions, isAcceptableFeed, isGithubUrl, releasePageUrl } from "./update-check.js";

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

describe("releasePageUrl", () => {
  it("is the release's page on github.com, which the app may open", () => {
    expect(releasePageUrl("BrandNewDevs/Elegant", "0.2.0")).toBe("https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0");
    expect(isGithubUrl(releasePageUrl("BrandNewDevs/Elegant", "0.2.0"))).toBe(true);
  });
});

describe("isAcceptableFeed", () => {
  const file = { url: "Elegant-0.2.0-arm64.zip", sha512: "abc+/==" };

  it("accepts files named bare, each with a sha512", () => {
    expect(isAcceptableFeed([file])).toBe(true);
  });

  it("refuses a file that is not a bare name, so it cannot point away from the release", () => {
    for (const url of ["https://evil.example/Elegant.zip", "//evil.example/Elegant.zip", "../Elegant.zip", "dir/Elegant.zip", "file:///tmp/Elegant.zip", "", undefined, 3]) {
      expect(isAcceptableFeed([{ ...file, url }])).toBe(false);
    }
  });

  it("refuses a file with no sha512, or no files at all", () => {
    expect(isAcceptableFeed([{ url: file.url }])).toBe(false);
    expect(isAcceptableFeed([{ ...file, sha512: "" }])).toBe(false);
    expect(isAcceptableFeed([file, { url: "other.zip" }])).toBe(false);
    expect(isAcceptableFeed([])).toBe(false);
  });
});
