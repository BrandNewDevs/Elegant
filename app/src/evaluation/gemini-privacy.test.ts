import { expect, it, vi } from "vitest";

const privateRead = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), readFile: privateRead,
}));

it("requires separate cloud consent before reading private evaluation material or contacting a provider", async () => {
  const previousArgs = process.argv;
  const fetch = vi.fn();
  try {
    process.argv = [previousArgs[0]!, "evaluation", "private-chat", "/private-manifest-sentinel.json", "/private-result-sentinel.json"];
    vi.stubEnv("AI_PROVIDER", "gemini");
    vi.stubEnv("AI_ALLOW_CLOUD_PRIVATE", "");
    vi.stubEnv("AI_SYNTHETIC_TRACE", "");
    vi.stubGlobal("fetch", fetch);
    await expect(import("./cli.js")).rejects.toThrow("Explicitly set AI_ALLOW_CLOUD_PRIVATE=1");
    expect(privateRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    process.argv = previousArgs;
    vi.unstubAllEnvs(); vi.unstubAllGlobals();
  }
});
