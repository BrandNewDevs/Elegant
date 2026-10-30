import { beforeEach, expect, it, vi } from "vitest";
import type { WebContents } from "electron";
import { openStore } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { Setup } from "../setup/setup.js";
import { AISettings } from "../setup/ai-settings.js";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: { sender: unknown }, ...args: unknown[]) => void>(),
  openExternal: vi.fn(async (_url: string) => {}),
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => void) => electron.handlers.set(channel, handler),
    handle: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => void) => electron.handlers.set(channel, handler),
  },
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

it("limits credential operations to attached windows and never pushes the saved key", async () => {
  const store = openStore(":memory:");
  const ai = new AISettings(store, {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => Buffer.from("protected:" + text),
    decryptStringAsync: async () => ({ result: "private-key", shouldReEncrypt: false }),
  });
  const setup = new Setup(new FakeEngine(), store, { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ({ status: "ready" }) });
  const bridge = new SetupBridge(setup, { ai, done: () => {}, openSettings: () => {} });
  const send = vi.fn();
  const page = { once: () => {}, isDestroyed: () => false, send } as unknown as WebContents;
  bridge.attach(page);
  const configure = electron.handlers.get("setup:configure-ai")!;
  expect(() => configure({ sender: {} }, { type: "save-key", key: "private-key" })).toThrow("cannot configure AI");
  await configure({ sender: page }, { type: "save-key", key: "private-key" });
  electron.handlers.get("setup:ready")!({ sender: page });
  expect(JSON.stringify(send.mock.calls)).not.toContain("private-key");
  expect(send.mock.calls.at(-1)?.[1].ai).toMatchObject({ hasGeminiKey: true, provider: "ollama" });
  store.close();
});

it("lists Gemini models only for attached windows", async () => {
  const store = openStore(":memory:");
  const listModels = vi.fn(async () => [{ id: "gemini-test", label: "Gemini Test" }]);
  const ai = new AISettings(store, {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => Buffer.from("protected:" + text),
    decryptStringAsync: async () => ({ result: "private-key", shouldReEncrypt: false }),
  }, undefined, listModels);
  const setup = new Setup(new FakeEngine(), store, { speechModel: "tiny", modelsDirectory: "/models", checkOllama: async () => ({ status: "ready" }) });
  const bridge = new SetupBridge(setup, { ai, done: () => {}, openSettings: () => {} });
  const page = { once: () => {}, isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
  bridge.attach(page);
  const models = electron.handlers.get("setup:gemini-models")!;
  expect(() => models({ sender: {} })).toThrow("cannot configure AI");
  await electron.handlers.get("setup:configure-ai")!({ sender: page }, { type: "save-key", key: "private-key" });
  expect(await models({ sender: page })).toEqual([{ id: "gemini-test", label: "Gemini Test" }]);
  store.close();
});
