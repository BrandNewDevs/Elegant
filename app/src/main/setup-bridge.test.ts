import { beforeEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { Setup } from "../setup/setup.js";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>(),
  openExternal: vi.fn(async (_url: string) => {}),
}));

vi.mock("electron", () => ({
  ipcMain: { on: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => void) => electron.handlers.set(channel, handler) },
  shell: { openExternal: electron.openExternal },
}));

const { SetupBridge } = await import("./setup-bridge.js");

function attachedBridge() {
  const store = openStore(":memory:");
  const setup = new Setup(new FakeEngine(), store, { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ({ status: "ready" }) });
  const bridge = new SetupBridge(setup, { done: () => {}, openSettings: () => {} });
  const page = { once: () => {}, isDestroyed: () => false, send: () => {} } as unknown as WebContents;
  bridge.attach(page);
  return page;
}

beforeEach(() => {
  electron.openExternal.mockClear();
});

it("opens the Microphone and Screen & System Audio Recording panes of System Settings", () => {
  const page = attachedBridge();
  electron.handlers.get("setup:act")!({ sender: page }, "settings-microphone");
  electron.handlers.get("setup:act")!({ sender: page }, "settings-system-audio");
  expect(electron.openExternal.mock.calls.map(([url]) => url)).toEqual([
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  ]);
});

it("ignores actions from a page that was never attached", () => {
  attachedBridge();
  electron.handlers.get("setup:act")!({ sender: {} }, "settings-microphone");
  expect(electron.openExternal).not.toHaveBeenCalled();
});
