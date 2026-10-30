import type { Store } from "../store/store.js";
import type { AISettingsAction, AISettingsView, AIProvider, GeminiModelOption } from "../shared/ai-settings.js";
import { DEFAULT_GEMINI_MODEL, GeminiClient, listGeminiModels, probeGeminiModel, validGeminiModel, type ModelProbe } from "../pipeline/gemini.js";
import type { TextModel } from "../pipeline/language-model.js";

export interface CredentialEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(buffer: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
export type AISelection = { provider: "ollama" } | { provider: "gemini"; model: string; apiKey: string };

/** Credentials are decrypted lazily: local-only launches never touch the OS keychain. */
export class AISettings {
  private readonly listeners = new Set<() => void>();
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private testController: AbortController | undefined;
  private listController: AbortController | undefined;
  private finding: { controller: AbortController; done: number; total: number } | undefined;
  constructor(private readonly store: Pick<Store, "getSetting" | "setSetting">, private readonly encryption: CredentialEncryption,
    private readonly testClient: (apiKey: string, model: string) => TextModel = (apiKey, model) => new GeminiClient({ apiKey, model }),
    private readonly listModels: (apiKey: string, signal: AbortSignal) => Promise<GeminiModelOption[]> = (apiKey, signal) => listGeminiModels({ apiKey, signal }),
    private readonly probeModel: (apiKey: string, model: string, signal: AbortSignal) => Promise<ModelProbe> = (apiKey, model, signal) => probeGeminiModel({ apiKey, model, signal }),
    /** How long to wait between two models, and before the one retry of a model that was rate-limited. */
    private readonly pauses = { betweenMs: 300, busyMs: 2_000 }) {}

  get view(): AISettingsView {
    return { provider: this.store.getSetting("ai.provider") === "gemini" ? "gemini" : "ollama",
      geminiModel: this.store.getSetting("ai.gemini.model") || DEFAULT_GEMINI_MODEL,
      hasGeminiKey: !!this.store.getSetting("ai.gemini.encryptedKey"),
      ...(this.usable() ? { usableModels: this.usable() } : {}),
      ...(this.finding ? { finding: { done: this.finding.done, total: this.finding.total } } : {}) };
  }
  /** The models that answered the last run for the saved key; undefined when no run was done for it. */
  private usable(): string[] | undefined {
    try {
      const saved = JSON.parse(this.store.getSetting("ai.gemini.usable") || "null");
      return Array.isArray(saved) && saved.every(m => typeof m === "string" && validGeminiModel(m)) ? saved : undefined;
    } catch { return undefined; }
  }
  private changed(): void {
    for (const listener of this.listeners) { try { listener(); } catch { /* Views cannot interrupt persistence. */ } }
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Capture provider/model/ciphertext together before any asynchronous work. */
  async snapshot(): Promise<AISelection> {
    if (this.closed) throw new Error("AI settings are shutting down");
    const view = this.view;
    if (view.provider === "ollama") return { provider: "ollama" };
    const encrypted = this.store.getSetting("ai.gemini.encryptedKey");
    if (!encrypted) throw new Error("Add a Gemini API key in Settings, or select Ollama");
    return { provider: "gemini", model: view.geminiModel, apiKey: await this.decrypt(encrypted) };
  }

  /** Serialize settings mutations so replacing/removing keys cannot race. */
  configure(value: unknown): Promise<string> {
    if (this.closed) return Promise.reject(new Error("AI settings are shutting down"));
    const result = this.pending.then(() => this.apply(value));
    this.pending = result.catch(() => {});
    return result;
  }

  /**
   * The Gemini text models the saved key can use, asked of Google. Only the key is sent, never Meeting content. It does not
   * change any setting, so it is not serialised with the changes that do.
   */
  async geminiModels(): Promise<GeminiModelOption[]> {
    if (this.closed) throw new Error("AI settings are shutting down");
    const encrypted = this.store.getSetting("ai.gemini.encryptedKey");
    if (!encrypted) throw new Error("Save a Gemini API key first");
    const apiKey = await this.decrypt(encrypted);
    if (this.closed) throw new Error("AI settings are shutting down");
    this.listController?.abort();
    const controller = (this.listController = new AbortController());
    try {
      return await this.listModels(apiKey, controller.signal);
    } finally {
      if (this.listController === controller) this.listController = undefined;
    }
  }

  /** A new or removed key is a different account, so what the last key could use says nothing about it. */
  private forgetUsable(): void {
    this.finding?.controller.abort();
    this.store.setSetting("ai.gemini.usable", "");
  }

  /**
   * Tries each model the key can see with one tiny synthetic request, and remembers the ones that answer, so the picker can
   * offer only models that work on this key (Gemini quotas are per model, so each try is independent). Meeting content is
   * never sent. A model Google refuses for quota, or that is rate-limited, is left out. Stopping keeps what was found so far.
   */
  async findUsableModels(): Promise<string> {
    if (this.closed) throw new Error("AI settings are shutting down");
    if (this.finding) throw new Error("Already looking for models that work");
    const encrypted = this.store.getSetting("ai.gemini.encryptedKey");
    if (!encrypted) throw new Error("Save a Gemini API key first");
    // Marked as running before anything is awaited, so a second press cannot start a second run.
    const run = (this.finding = { controller: new AbortController(), done: 0, total: 0 });
    this.changed();
    const usable: string[] = [];
    let stopped = false;
    // A key that changed meanwhile cleared the results; the old key's must not be written back, nor must anything after shutdown.
    const save = () => {
      if (this.store.getSetting("ai.gemini.encryptedKey") === encrypted && !this.closed) this.store.setSetting("ai.gemini.usable", JSON.stringify([...usable].sort()));
    };
    try {
      const apiKey = await this.decrypt(encrypted);
      run.controller.signal.throwIfAborted();
      const listed = (await this.listModels(apiKey, run.controller.signal)).map(m => m.id);
      // Models likelier to be on a free plan first, so a stopped run has already tried the ones that matter most.
      const rank = (id: string) => (/flash-lite/.test(id) ? 0 : /flash/.test(id) ? 1 : 2);
      const candidates = [...listed].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      run.total = candidates.length;
      this.changed();
      for (const [index, model] of candidates.entries()) {
        run.controller.signal.throwIfAborted();
        let result = await this.probeModel(apiKey, model, run.controller.signal);
        if (result === "busy") { // rate-limited right now, not refused: one more try after a short pause
          await this.pause(this.pauses.busyMs);
          result = await this.probeModel(apiKey, model, run.controller.signal);
        }
        if (result === "ok") usable.push(model);
        run.done = index + 1;
        this.changed();
        if (index < candidates.length - 1) await this.pause(this.pauses.betweenMs);
      }
      save();
    } catch (error) {
      if (!run.controller.signal.aborted) throw error; // a failure saves nothing, so the last good results stay
      stopped = true;
      save();
    } finally {
      this.finding = undefined;
      this.changed();
    }
    const count = `${usable.length} model${usable.length === 1 ? "" : "s"}`;
    return stopped ? `Stopped. ${count} answered so far.` : usable.length ? `Found ${count} that ${usable.length === 1 ? "works" : "work"} on your key.` : "None of the models answered on your key. Check its quota in Google AI Studio.";
  }

  /** Stops a run in progress, keeping the models found so far. */
  stopFindingModels(): void {
    this.finding?.controller.abort();
  }

  private pause(ms: number): Promise<void> {
    const signal = this.finding?.controller.signal;
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.testController?.abort();
    this.listController?.abort();
    this.finding?.controller.abort();
    await this.pending;
  }

  private async decrypt(encrypted: string): Promise<string> {
    try {
      if (!await this.encryption.isAsyncEncryptionAvailable()) throw new Error();
      return (await this.encryption.decryptStringAsync(Buffer.from(encrypted, "base64"))).result;
    } catch { throw new Error("The saved Gemini key cannot be unlocked. Unlock your Mac keychain or replace the key in Settings."); }
  }

  private async apply(value: unknown): Promise<string> {
    if (this.closed) throw new Error("AI settings are shutting down");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid AI settings action");
    const action = value as AISettingsAction;
    const fields: Record<string, string[]> = { select: ["type", "provider", "consent"], "save-key": ["type", "key"], "remove-key": ["type"], model: ["type", "model"], test: ["type"] };
    if (!fields[action.type] || Object.keys(value).some(k => !fields[action.type]!.includes(k))) throw new Error("Invalid AI settings action");
    let message = "AI settings saved";
    switch (action.type) {
      case "select":
        if (!( ["ollama", "gemini"] as AIProvider[]).includes(action.provider)) throw new Error("Choose Ollama or Gemini");
        if (action.provider === "gemini" && action.consent !== true) throw new Error("Confirm that Transcript evidence and questions will be sent to Google");
        if (action.provider === "gemini" && !this.view.hasGeminiKey) throw new Error("Save a Gemini API key before selecting Gemini");
        this.store.setSetting("ai.provider", action.provider);
        break;
      case "save-key": {
        if (typeof action.key !== "string" || !action.key.trim() || /\s/.test(action.key.trim()) || action.key.trim().length > 512) throw new Error("Enter a valid Gemini API key");
        let encrypted: Buffer;
        try {
          if (!await this.encryption.isAsyncEncryptionAvailable()) throw new Error();
          encrypted = await this.encryption.encryptStringAsync(action.key.trim());
        } catch { throw new Error("Secure credential storage is unavailable. Unlock your Mac keychain and retry."); }
        if (this.closed) throw new Error("AI settings are shutting down");
        this.forgetUsable();
        this.store.setSetting("ai.gemini.encryptedKey", encrypted.toString("base64"));
        message = "Gemini key saved securely";
        break;
      }
      case "remove-key":
        // Do not automatically change providers or send queued work somewhere else.
        this.forgetUsable();
        this.store.setSetting("ai.gemini.encryptedKey", "");
        message = "Gemini key removed. New Gemini requests need a key.";
        break;
      case "model":
        if (typeof action.model !== "string" || !validGeminiModel(action.model)) throw new Error("Enter a Gemini text model name, such as " + DEFAULT_GEMINI_MODEL);
        this.store.setSetting("ai.gemini.model", action.model);
        break;
      case "test": {
        const view = this.view, encrypted = this.store.getSetting("ai.gemini.encryptedKey");
        if (!encrypted) throw new Error("Save a Gemini API key first");
        const apiKey = await this.decrypt(encrypted);
        if (this.closed) throw new Error("AI settings are shutting down");
        this.testController = new AbortController();
        try {
          await this.testClient(apiKey, view.geminiModel).complete({ messages: [{ role: "user", content: "Connection test only. Return {\"ok\":true}." }],
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, signal: this.testController.signal, timeoutMs: 30_000, maxOutputTokens: 256 });
        } finally { this.testController = undefined; }
        message = "Gemini connection succeeded. No Meeting content was sent.";
        break;
      }
    }
    this.changed();
    return message;
  }
}
