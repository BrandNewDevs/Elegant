import { expect, it, vi } from "vitest";

const privateRead = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), readFile: privateRead,
}));

it("rejects private tracing before reading a manifest or contacting a model", async () => {
  const previousArgs = process.argv;
  const fetch = vi.fn();
  try {
    process.argv = [previousArgs[0]!, "evaluation", "private-chat", "/private-manifest-sentinel.json", "/private-result-sentinel.json"];
    vi.stubEnv("AI_SYNTHETIC_TRACE", "1");
    vi.stubGlobal("fetch", fetch);
    await expect(import("./cli.js")).rejects.toThrow("Synthetic tracing is available only for current synthetic evaluation");
    expect(privateRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    process.argv = previousArgs;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
