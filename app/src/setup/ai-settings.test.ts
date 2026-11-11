import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/store.js";
import { probeGeminiModel, type ModelProbe } from "../pipeline/gemini.js";
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
it("cancels a test that has not reached Gemini yet", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  let unlock!: () => void;
  vi.mocked(f.encryption.decryptStringAsync).mockImplementationOnce(buffer => new Promise(resolve => { unlock = () => resolve({ result: buffer.toString().slice(10), shouldReEncrypt: false }); }));
  const work = f.settings.configure({ type: "test" });
  await vi.waitFor(() => expect(f.encryption.decryptStringAsync).toHaveBeenCalled());
  await f.settings.configure({ type: "cancel-test" });
  unlock();
  await expect(work).rejects.toThrow("cancelled");
  expect(f.complete).not.toHaveBeenCalled();
  f.store.close();
});
it("explains a connection-test timeout as a setup problem", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  f.complete.mockRejectedValue(Object.assign(new Error("Gemini request timed out. Retry or ask a narrower question."), { name: "TimeoutError" }));
  await expect(f.settings.configure({ type: "test" })).rejects.toThrow("timed out after 60 seconds. Check network access and the saved model");
  f.store.close();
});
it("requests low thinking only for the default model", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  await f.settings.configure({ type: "test" });
  await f.settings.configure({ type: "model", model: "gemini-other" });
  await f.settings.configure({ type: "test" });
  const requests = f.complete.mock.calls.map(call => (call as unknown[])[0]);
  expect(requests[0]).toMatchObject({ thinkingLevel: "low" });
  expect(requests[1]).not.toHaveProperty("thinkingLevel");
  f.store.close();
});

it("lists the models with the decrypted key, never exposing it, and needs a saved key", async () => {
  const f = fixture();
  const listModels = vi.fn(async () => [{ id: "gemini-test", label: "Gemini Test" }]);
  const settings = new AISettings(f.store, f.encryption, f.createClient, listModels);
  await expect(settings.geminiModels()).rejects.toThrow("Save a Gemini API key first");
  expect(listModels).not.toHaveBeenCalled();
  await settings.configure({ type: "save-key", key: "secret-test-key" });
  expect(await settings.geminiModels()).toEqual([{ id: "gemini-test", label: "Gemini Test" }]);
  expect(listModels).toHaveBeenCalledWith("secret-test-key", expect.any(AbortSignal));
  expect(settings.view.provider).toBe("ollama"); // looking at the list never turns Gemini on
  f.store.close();
});

it("cancels a model list in flight when the settings shut down, and refuses new ones", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  const listModels = vi.fn((_key: string, s: AbortSignal) => new Promise<never>((_resolve, reject) => { signal = s; s.addEventListener("abort", () => reject(new Error("cancelled"))); }));
  const settings = new AISettings(f.store, f.encryption, f.createClient, listModels);
  await settings.configure({ type: "save-key", key: "secret-test-key" });
  const pending = settings.geminiModels();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await settings.shutdown();
  await expect(pending).rejects.toThrow("cancelled");
  await expect(settings.geminiModels()).rejects.toThrow("shutting down");
  f.store.close();
});

/** Settings that list `ids`, and probe each one with the outcome `outcomes[id]` (default "ok"), with no waiting between models. */
function finder(ids: string[], outcomes: Record<string, ModelProbe | ModelProbe[]> = {}) {
  const f = fixture();
  const tried: string[] = [];
  const listModels = vi.fn(async () => ids.map(id => ({ id, label: id })));
  const probeModel = vi.fn(async (_key: string, model: string, signal: AbortSignal): Promise<ModelProbe> => {
    signal.throwIfAborted();
    tried.push(model);
    const outcome = outcomes[model] ?? { status: "ok" };
    return Array.isArray(outcome) ? (outcome.shift() ?? { status: "ok" }) : outcome;
  });
  const settings = new AISettings(f.store, f.encryption, f.createClient, listModels, probeModel, { betweenMs: 0, busyMs: 0 });
  return { ...f, settings, tried, probeModel, listModels };
}

it("keeps the models that answered, flash-lite and flash first, and offers them as the usable ones", async () => {
  const f = finder(["gemini-pro", "gemini-flash", "gemini-flash-lite", "gemini-argon"], { "gemini-argon": { status: "no-quota" }, "gemini-pro": { status: "invalid-output" } });
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  expect(f.settings.view.usableModels).toBeUndefined();
  expect(await f.settings.findUsableModels()).toBe("Found 2 models that work on your key.");
  f.settings.stopFindingModels();
  expect(f.tried.slice(0, 3)).toEqual(["gemini-flash-lite", "gemini-flash", "gemini-argon"]);
  expect(f.settings.view.usableModels).toEqual(["gemini-flash", "gemini-flash-lite"]);
  expect(f.settings.view.finding).toBeUndefined();
  expect(f.settings.view.provider).toBe("ollama"); // finding models never turns Gemini on
  f.store.close();
});

it("retries a rate-limited model once, and counts it usable when the retry answers", async () => {
  const f = finder(["gemini-flash"], { "gemini-flash": [{ status: "busy" }, { status: "ok" }] });
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  await f.settings.findUsableModels();
  expect(f.probeModel).toHaveBeenCalledTimes(2);
  expect(f.settings.view.usableModels).toEqual(["gemini-flash"]);
  f.store.close();
});

it("reports progress through the settings view while it runs", async () => {
  const f = finder(["gemini-a", "gemini-b", "gemini-c"]);
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  const seen: ({ done: number; total: number } | undefined)[] = [];
  f.settings.onChange(() => seen.push(f.settings.view.finding));
  await f.settings.findUsableModels();
  expect(seen[0]).toEqual({ done: 0, total: 0 });
  expect(seen).toContainEqual({ done: 0, total: 3 });
  expect(seen).toContainEqual({ done: 3, total: 3 });
  expect(seen.at(-1)).toBeUndefined();
  f.store.close();
});

it("says so when no model answers, and refuses to start twice or without a key", async () => {
  const f = finder(["gemini-a"], { "gemini-a": { status: "no-quota" } });
  await expect(f.settings.findUsableModels()).rejects.toThrow("Save a Gemini API key first");
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  const first = f.settings.findUsableModels();
  await expect(f.settings.findUsableModels()).rejects.toThrow("Already looking");
  expect(await first).toContain("None of the models answered");
  expect(f.settings.view.usableModels).toEqual([]);
  f.store.close();
});

it("keeps what was found so far when stopped", async () => {
  const f = finder(["gemini-flash-lite", "gemini-flash", "gemini-pro"]);
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  f.probeModel.mockImplementation(async (_key, model, signal) => { if (model === "gemini-flash") f.settings.stopFindingModels(); signal.throwIfAborted(); return { status: "ok" }; });
  expect(await f.settings.findUsableModels()).toBe("Stopped. 1 model answered so far.");
  expect(f.settings.view.usableModels).toEqual(["gemini-flash-lite"]);
  f.store.close();
});

it("forgets the results when the key changes, even while a run is going on, and does not save the old key's results", async () => {
  const f = finder(["gemini-a", "gemini-b"]);
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  await f.settings.findUsableModels();
  expect(f.settings.view.usableModels).toEqual(["gemini-a", "gemini-b"]);
  await f.settings.configure({ type: "save-key", key: "another-key" });
  expect(f.settings.view.usableModels).toBeUndefined();

  f.probeModel.mockImplementation(async (_key, model, signal) => { if (model === "gemini-a") await f.settings.configure({ type: "remove-key" }); signal.throwIfAborted(); return { status: "ok" }; });
  await f.settings.findUsableModels();
  expect(f.settings.view.usableModels).toBeUndefined();
  f.store.close();
});

it("stops with the cause, and keeps the last good results, when a model cannot be tried at all", async () => {
  const f = finder(["gemini-a", "gemini-b"]);
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  await f.settings.findUsableModels();
  f.probeModel.mockRejectedValue(new Error("Could not reach Gemini. Check your connection and retry."));
  await expect(f.settings.findUsableModels()).rejects.toThrow("Could not reach Gemini");
  expect(f.settings.view.finding).toBeUndefined();
  expect(f.settings.view.usableModels).toEqual(["gemini-a", "gemini-b"]);
  f.store.close();
});

it("gives the connection test room to think, since thinking tokens count against the output cap", async () => {
  const f = fixture();
  await f.settings.configure({ type: "save-key", key: "secret-test-key" });
  await f.settings.configure({ type: "test" });
  expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 2048, timeoutMs: 60_000 }));
  f.store.close();
});

it("preserves discovered models when Google is overloaded for every model", async () => {
  const f = fixture();
  const fetcher = vi.fn<typeof fetch>(async () => new Response("private server details", { status: 503 }));
  const settings = new AISettings(f.store, f.encryption, f.createClient,
    async () => ["gemini-a", "gemini-b"].map(id => ({ id, label: id })),
    (apiKey, model, signal) => probeGeminiModel({ apiKey, model, signal, fetch: fetcher }), { betweenMs: 0, busyMs: 0 });
  await settings.configure({ type: "save-key", key: "synthetic" });
  f.store.setSetting("ai.gemini.usable", '["gemini-previous"]');
  await expect(settings.findUsableModels()).rejects.toThrow("busy or overloaded for every model");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(settings.view.usableModels).toEqual(["gemini-previous"]);
  expect(settings.view.finding).toBeUndefined();
  f.store.close();
});

it("skips an overloaded model and keeps the ones that answered after it", async () => {
  const f = finder(["gemini-flash-lite", "gemini-flash", "gemini-pro"], { "gemini-flash-lite": { status: "overloaded" } });
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  expect(await f.settings.findUsableModels()).toBe("Found 2 models that work on your key. Skipped 1 that was busy; find again later to check it.");
  expect(f.probeModel).toHaveBeenCalledTimes(3); // an overloaded model is not retried
  expect(f.settings.view.usableModels).toEqual(["gemini-flash", "gemini-pro"]);
  f.store.close();
});

it("respects Google's retry delay and makes the waiting retry cancellable", async () => {
  vi.useFakeTimers();
  const f = finder(["gemini-a"], { "gemini-a": [{ status: "busy", retryDelaySeconds: 28 }, { status: "ok" }] });
  try {
    await f.settings.configure({ type: "save-key", key: "synthetic" });
    const work = f.settings.findUsableModels();
    await vi.advanceTimersByTimeAsync(27_999);
    expect(f.probeModel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(f.probeModel).toHaveBeenCalledTimes(2);
    f.probeModel.mockResolvedValue({ status: "busy", retryDelaySeconds: 28 });
    const stopped = f.settings.findUsableModels();
    await vi.advanceTimersByTimeAsync(0);
    f.settings.stopFindingModels();
    await expect(stopped).resolves.toContain("Stopped");
    expect(f.probeModel).toHaveBeenCalledTimes(3);
  } finally { vi.useRealTimers(); f.store.close(); }
});

it.each([2, 120])("skips a model whose rate limit persists or needs a long wait (%s seconds), and keeps the rest", async delay => {
  const f = finder(["gemini-a", "gemini-b"], { "gemini-a": { status: "busy", retryDelaySeconds: delay } });
  vi.useFakeTimers();
  try {
    await f.settings.configure({ type: "save-key", key: "synthetic" });
    const found = f.settings.findUsableModels();
    await vi.runAllTimersAsync();
    expect(await found).toContain("Skipped 1 that was busy");
    expect(f.probeModel).toHaveBeenCalledTimes(delay > 60 ? 2 : 3);
    expect(f.settings.view.usableModels).toEqual(["gemini-b"]);
  } finally { vi.useRealTimers(); f.store.close(); }
});

it("keeps previous discoveries when every model stays rate-limited", async () => {
  const f = finder(["gemini-a"], { "gemini-a": { status: "busy", retryDelaySeconds: 2 } });
  vi.useFakeTimers();
  try {
    await f.settings.configure({ type: "save-key", key: "synthetic" });
    f.store.setSetting("ai.gemini.usable", '["gemini-previous"]');
    const failed = expect(f.settings.findUsableModels()).rejects.toThrow("busy or overloaded for every model");
    await vi.runAllTimersAsync();
    await failed;
    expect(f.settings.view.usableModels).toEqual(["gemini-previous"]);
  } finally { vi.useRealTimers(); f.store.close(); }
});

it("invalidates pending model lists and advances a non-secret revision on key replacement", async () => {
  const f = fixture();
  let finish!: (models: { id: string; label: string }[]) => void;
  let signal!: AbortSignal;
  const settings = new AISettings(f.store, f.encryption, f.createClient, async (_key, s) => {
    signal = s;
    return new Promise(resolve => { finish = resolve; });
  });
  await settings.configure({ type: "save-key", key: "synthetic-old" });
  const revision = settings.view.geminiKeyRevision;
  const pending = settings.geminiModels();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await settings.configure({ type: "save-key", key: "synthetic-new" });
  expect(signal.aborted).toBe(true);
  expect(settings.view.geminiKeyRevision).not.toBe(revision);
  finish([{ id: "gemini-old", label: "Old" }]);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(JSON.stringify(settings.view)).not.toContain("synthetic");
  f.store.close();
});

it("does not send the old key if replacement happens while the keychain is unlocking", async () => {
  const f = fixture();
  const list = vi.fn(async () => [{ id: "gemini-new", label: "New" }]);
  const settings = new AISettings(f.store, f.encryption, f.createClient, list);
  await settings.configure({ type: "save-key", key: "old" });
  let unlock!: () => void;
  vi.mocked(f.encryption.decryptStringAsync).mockImplementationOnce(() => new Promise(resolve => {
    unlock = () => resolve({ result: "old", shouldReEncrypt: false });
  }));
  const old = settings.geminiModels();
  const cancelled = expect(old).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(unlock).toBeDefined());
  await settings.configure({ type: "save-key", key: "new" });
  expect(await settings.geminiModels()).toEqual([{ id: "gemini-new", label: "New" }]);
  unlock();
  await cancelled;
  expect(list).toHaveBeenCalledTimes(1);
  expect(list).toHaveBeenCalledWith("new", expect.any(AbortSignal));
  f.store.close();
});

it("does not read closed storage when a cancelled discovery finishes after shutdown", async () => {
  const f = finder(["gemini-a"]);
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  let finish!: () => void;
  f.probeModel.mockImplementation(async (_key, _model, signal) => {
    await new Promise<void>(resolve => { finish = resolve; });
    signal.throwIfAborted();
    return { status: "ok" };
  });
  const running = f.settings.findUsableModels();
  await vi.waitFor(() => expect(finish).toBeDefined());
  await f.settings.shutdown();
  f.store.close();
  finish();
  await expect(running).resolves.toContain("Stopped");
});

it("does not restore a cancelled discovery when the same key is saved again", async () => {
  const f = finder(["gemini-a", "gemini-b"]);
  await f.settings.configure({ type: "save-key", key: "synthetic" });
  f.probeModel.mockImplementation(async (_key, model, signal) => {
    if (model === "gemini-b") await f.settings.configure({ type: "save-key", key: "synthetic" });
    signal.throwIfAborted();
    return { status: "ok" };
  });
  await expect(f.settings.findUsableModels()).resolves.toContain("Stopped");
  expect(f.settings.view.usableModels).toBeUndefined();
  f.store.close();
});
