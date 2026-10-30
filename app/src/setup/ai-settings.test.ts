import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/store.js";
import { AISettings, type CredentialEncryption } from "./ai-settings.js";

function fixture() {
  const store = openStore(":memory:");
  const encryption: CredentialEncryption = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async key => Buffer.from("protected:" + key)),
    decryptStringAsync: vi.fn(async buffer => ({ result: buffer.toString().slice(10), shouldReEncrypt: false })),
  };
  const complete = vi.fn(async () => ({ text: '{"ok":true}', metadata: { model: "gemini-test", elapsedMs: 1 } }));
  const createClient = vi.fn(() => ({ complete }));
  const settings = new AISettings(store, encryption, createClient);
  return { store, encryption, complete, createClient, settings };
}

it("defaults to the original local provider without touching credentials or the network", async () => {
  const f = fixture();
  expect(f.settings.view.provider).toBe("ollama");
  expect(await f.settings.snapshot()).toEqual({ provider: "ollama" });
  expect(f.encryption.isAsyncEncryptionAvailable).not.toHaveBeenCalled();
  expect(f.createClient).not.toHaveBeenCalled();
  f.store.close();
});

it("requires explicit cloud consent and a saved key, encrypting rather than exposing credentials", async () => {
  const f = fixture();
  await expect(f.settings.configure({ type: "select", provider: "gemini", consent: true })).rejects.toThrow("Save a Gemini API key");
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  await expect(f.settings.configure({ type: "select", provider: "gemini" })).rejects.toThrow("Confirm");
  await f.settings.configure({ type: "select", provider: "gemini", consent: true });
  expect(JSON.stringify(f.settings.view)).not.toContain("secret-test-key");
  expect(f.store.getSetting("ai.gemini.encryptedKey")).not.toContain("secret-test-key");
  expect(await f.settings.snapshot()).toMatchObject({ provider: "gemini", apiKey: "secret-test-key" });
  f.store.close();
});

it("preserves settings across reopen, replaces/removes credentials and never silently changes provider", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "old" });
  await f.settings.configure({ type: "select", provider: "gemini", consent: true });
  await f.settings.configure({ type: "model", model: "gemini-test" });
  await f.settings.configure({ type: "save-key", key: "replacement" });
  const reopened = new AISettings(f.store, f.encryption);
  expect(await reopened.snapshot()).toEqual({ provider: "gemini", model: "gemini-test", apiKey: "replacement" });
  await f.settings.configure({ type: "remove-key" });
  expect(f.settings.view.provider).toBe("gemini");
  await expect(f.settings.snapshot()).rejects.toThrow("Add a Gemini API key");
  await f.settings.configure({ type: "select", provider: "ollama" });
  expect(await f.settings.snapshot()).toEqual({ provider: "ollama" });
  f.store.close();
});

it("fails closed when encryption is unavailable, sanitizing keychain failures", async () => {
  const f = fixture();
  vi.mocked(f.encryption.isAsyncEncryptionAvailable).mockResolvedValue(false);
  await expect(f.settings.configure({ type: "save-key", key: "secret" })).rejects.toThrow("Secure credential storage is unavailable");
  expect(f.settings.view.hasGeminiKey).toBe(false);
  vi.mocked(f.encryption.isAsyncEncryptionAvailable).mockResolvedValue(true);
  await f.settings.configure({ type: "save-key", key: "secret" });
  await f.settings.configure({ type: "select", provider: "gemini", consent: true });
  vi.mocked(f.encryption.decryptStringAsync).mockRejectedValue(new Error("private secret"));
  await expect(f.settings.snapshot()).rejects.toThrow("saved Gemini key cannot be unlocked");
  f.store.close();
});

it("tests the saved model with a synthetic request and rejects unexpected IPC fields", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "secret" });
  await expect(f.settings.configure({ type: "select", provider: "gemini", consent: true, apiKey: "injected" })).rejects.toThrow("Invalid AI settings");
  await expect(f.settings.configure({ type: "model", model: "../../other-endpoint" })).rejects.toThrow("Gemini text model");
  expect(await f.settings.configure({ type: "test" })).toContain("No Meeting content");
  expect(f.settings.view.provider).toBe("ollama");
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.complete.mock.calls)).toContain("Connection test only");
  f.store.close();
});

it("waits for pending credential work before storage can close and rejects new work on shutdown", async () => {
  const f = fixture();
  let release: (value: Buffer) => void = () => {};
  vi.mocked(f.encryption.encryptStringAsync).mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const saving = f.settings.configure({ type: "save-key", key: "secret" });
  await vi.waitFor(() => expect(f.encryption.encryptStringAsync).toHaveBeenCalled());
  const stopped = f.settings.shutdown();
  await expect(f.settings.configure({ type: "select", provider: "ollama" })).rejects.toThrow("shutting down");
  release(Buffer.from("protected:secret"));
  await expect(saving).rejects.toThrow("shutting down");
  await stopped;
  expect(f.settings.view.hasGeminiKey).toBe(false);
  f.store.close();
});

it("restores provider and encrypted credentials from disk without rewriting an existing Summary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "elegant-ai-settings-"));
  const encryption: CredentialEncryption = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async key => Buffer.from("test-encryption:" + key),
    decryptStringAsync: async buffer => ({ result: buffer.toString().slice(16), shouldReEncrypt: false }),
  };
  let store: ReturnType<typeof openStore> | undefined;
  try {
    const path = join(directory, "meetings.db");
    store = openStore(path);
    const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-30T10:00:00Z" });
    const previous = { tldr: "Previously saved local Summary", participants: [] };
    store.saveSummary(id, previous);
    const settings = new AISettings(store, encryption);
    await settings.configure({ type: "save-key", key: "synthetic-key" });
    await settings.configure({ type: "select", provider: "gemini", consent: true });
    await settings.shutdown();
    store.close(); store = undefined;
    store = openStore(path);
    const restored = new AISettings(store, encryption);
    expect(await restored.snapshot()).toMatchObject({ provider: "gemini", apiKey: "synthetic-key" });
    expect(store.getMeeting(id)?.summary).toEqual(previous);
    await restored.configure({ type: "select", provider: "ollama" });
    expect(store.getMeeting(id)?.summary).toEqual(previous);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects false and malformed connection confirmations", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  for (const text of ['{"ok":false}', 'not JSON']) {
    f.complete.mockResolvedValue({ text, metadata: { model: "synthetic", elapsedMs: 1 } });
    await expect(f.settings.configure({ type: "test" })).rejects.toThrow(/connection test/);
  }
  f.store.close();
});
it("cancels an active test outside the serialized mutation queue", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  f.complete.mockImplementation(async (...args: unknown[]) => {
    const request = args[0] as { signal: AbortSignal };
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  });
  const work = f.settings.configure({ type: "test" });
  const failure = expect(work).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(f.complete).toHaveBeenCalled());
  await f.settings.configure({ type: "cancel-test" });
  await failure;
  await f.settings.configure({ type: "select", provider: "ollama" });
  f.store.close();
});
