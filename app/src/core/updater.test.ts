import { afterEach, describe, expect, it, vi } from "vitest";
import { Updater, type RestartBlock, type UpdateDriver, type UpdateState } from "./updater.js";

/** Stands in for electron-updater: each step can be held, failed or answered by the test. */
function fakeDriver(patch: Partial<UpdateDriver> = {}) {
  const driver = {
    check: vi.fn(async (): Promise<string | undefined> => "0.2.0"),
    download: vi.fn(async (onProgress: (percent: number) => void) => { onProgress(50); }),
    install: vi.fn(),
  };
  return { ...driver, ...patch } as typeof driver;
}

function updater(driver: UpdateDriver, patch: { currentVersion?: string; enabled?: () => boolean; restartBlock?: () => RestartBlock | undefined; checkTimeoutMs?: number } = {}) {
  const installing: boolean[] = [];
  const states: UpdateState[] = [];
  const u = new Updater({
    currentVersion: "0.1.2",
    repo: "BrandNewDevs/Elegant",
    driver,
    enabled: () => true,
    restartBlock: () => undefined,
    onInstalling: (value) => installing.push(value),
    ...patch,
  });
  u.onChange((state) => states.push(state));
  return { u, installing, states };
}

afterEach(() => vi.useRealTimers());

describe("looking for an update at launch", () => {
  it("downloads a newer release and says when it is ready, with progress on the way", async () => {
    const driver = fakeDriver({ download: vi.fn(async (onProgress) => { onProgress(10.2); onProgress(10.4); onProgress(55); }) });
    const { u, states } = updater(driver);
    await u.start();
    expect(states).toEqual([
      { status: "downloading", version: "0.2.0", percent: 0 },
      { status: "downloading", version: "0.2.0", percent: 10 }, // 10.4 is still 10
      { status: "downloading", version: "0.2.0", percent: 55 },
      { status: "ready", version: "0.2.0" },
    ]);
    expect(u.state).toEqual({ status: "ready", version: "0.2.0" });
    expect(driver.install).not.toHaveBeenCalled(); // never restarts by itself
  });

  it("does nothing when there is no newer release, or the driver names the same or an older version", async () => {
    for (const found of [undefined, "0.1.2", "0.1.1", "0.2.0-rc.1" /* a pre-release is older than its release */]) {
      const driver = fakeDriver({ check: vi.fn(async () => found) });
      const { u } = updater(driver, { currentVersion: found === "0.2.0-rc.1" ? "0.2.0" : "0.1.2" });
      await u.start();
      expect(u.state).toEqual({ status: "idle" });
      expect(driver.download).not.toHaveBeenCalled();
    }
  });

  it("does nothing for a version it cannot read", async () => {
    const driver = fakeDriver({ check: vi.fn(async () => "latest") });
    const { u } = updater(driver);
    await u.start();
    expect(u.state).toEqual({ status: "idle" });
    expect(driver.download).not.toHaveBeenCalled();
  });

  it("makes no request while the setting is off, and drops an answer that arrives after it was turned off", async () => {
    let enabled = false;
    const off = fakeDriver();
    await updater(off, { enabled: () => enabled }).u.start();
    expect(off.check).not.toHaveBeenCalled();

    enabled = true;
    const turnedOff = fakeDriver({ check: vi.fn(async () => { enabled = false; return "0.2.0"; }) });
    const { u } = updater(turnedOff, { enabled: () => enabled });
    await u.start();
    expect(turnedOff.download).not.toHaveBeenCalled();
    expect(u.state).toEqual({ status: "idle" });
  });

  it("checks once, however often it is started", async () => {
    const driver = fakeDriver();
    const { u } = updater(driver);
    await u.start();
    await u.start();
    expect(driver.check).toHaveBeenCalledTimes(1);
  });

  it("is silent when GitHub cannot be reached, or does not answer in time", async () => {
    const offline = fakeDriver({ check: vi.fn(async () => { throw new Error("net::ERR_INTERNET_DISCONNECTED"); }) });
    const a = updater(offline);
    await a.u.start();
    expect(a.u.state).toEqual({ status: "idle" });
    expect(a.states).toEqual([]);

    vi.useFakeTimers();
    const hanging = fakeDriver({ check: vi.fn(() => new Promise<string | undefined>(() => {})) });
    const b = updater(hanging, { checkTimeoutMs: 3000 });
    const done = b.u.start();
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(b.states).toEqual([]);
  });

  it("reports a download or signature failure with the release page to get the update by hand", async () => {
    const driver = fakeDriver({ download: vi.fn(async () => { throw new Error("Code signature did not pass validation"); }) });
    const { u, states } = updater(driver);
    await u.start();
    expect(states.at(-1)).toEqual({
      status: "failed",
      version: "0.2.0",
      url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0",
      message: "Code signature did not pass validation",
    });
    expect(driver.install).not.toHaveBeenCalled();
  });
});

describe("restarting to install", () => {
  async function ready(block: () => RestartBlock | undefined = () => undefined) {
    const driver = fakeDriver();
    const ctx = updater(driver, { restartBlock: block });
    await ctx.u.start();
    return { driver, ...ctx };
  }

  it("installs when an update is ready and nothing is going on", async () => {
    const { u, driver, installing } = await ready();
    expect(u.restart()).toEqual({ ok: true });
    expect(driver.install).toHaveBeenCalledTimes(1);
    expect(installing).toEqual([true]);
    expect(u.restart()).toMatchObject({ ok: false }); // a second press does not install twice
    expect(driver.install).toHaveBeenCalledTimes(1);
  });

  it("refuses during a Recording and says why, leaving the update ready", async () => {
    let block: RestartBlock | undefined = "recording";
    const { u, driver, installing } = await ready(() => block);
    const refused = u.restart();
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining("Recording is in progress") });
    expect(driver.install).not.toHaveBeenCalled();
    expect(installing).toEqual([]);
    expect(u.state).toEqual({ status: "ready", version: "0.2.0" });

    block = undefined; // the Recording was stopped and processed
    expect(u.restart()).toEqual({ ok: true });
  });

  it("refuses while AI work is running and says why", async () => {
    const { u, driver } = await ready(() => "ai-work");
    expect(u.restart()).toMatchObject({ ok: false, reason: expect.stringContaining("transcribing or summarising") });
    expect(driver.install).not.toHaveBeenCalled();
  });

  it("refuses when nothing is ready: not checked yet, still downloading, or failed", async () => {
    const idle = updater(fakeDriver());
    expect(idle.u.restart()).toMatchObject({ ok: false });

    let finish!: () => void;
    const slow = fakeDriver({ download: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })) });
    const downloading = updater(slow);
    const started = downloading.u.start();
    await vi.waitFor(() => expect(downloading.u.state.status).toBe("downloading"));
    expect(downloading.u.restart()).toMatchObject({ ok: false });
    expect(slow.install).not.toHaveBeenCalled();
    finish();
    await started;

    const failed = updater(fakeDriver({ download: vi.fn(async () => { throw new Error("no"); }) }));
    await failed.u.start();
    expect(failed.u.restart()).toMatchObject({ ok: false });
  });

  it("lets windows open again and reports it when the installer throws", async () => {
    const { u, driver, installing } = await ready();
    driver.install.mockImplementation(() => { throw new Error("no update staged"); });
    expect(u.restart()).toMatchObject({ ok: false, reason: expect.stringContaining("no update staged") });
    expect(installing).toEqual([true, false]);
    driver.install.mockImplementation(() => {});
    expect(u.restart()).toEqual({ ok: true }); // can be tried again
  });
});
