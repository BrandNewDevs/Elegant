import type { Store } from "../store/store.js";
import type { AISettingsAction, AISettingsView, AIProvider } from "../shared/ai-settings.js";
import { DEFAULT_GEMINI_MODEL, GeminiClient, validGeminiModel } from "../pipeline/gemini.js";
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
  constructor(private readonly store: Pick<Store, "getSetting" | "setSetting">, private readonly encryption: CredentialEncryption,
    private readonly testClient: (apiKey: string, model: string) => TextModel = (apiKey, model) => new GeminiClient({ apiKey, model })) {}

  get view(): AISettingsView {
    return { provider: this.store.getSetting("ai.provider") === "gemini" ? "gemini" : "ollama",
      geminiModel: this.store.getSetting("ai.gemini.model") || DEFAULT_GEMINI_MODEL,
      hasGeminiKey: !!this.store.getSetting("ai.gemini.encryptedKey") };
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

  async shutdown(): Promise<void> {
    this.closed = true;
    this.testController?.abort();
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
        this.store.setSetting("ai.gemini.encryptedKey", encrypted.toString("base64"));
        message = "Gemini key saved securely";
        break;
      }
      case "remove-key":
        // Do not automatically change providers or send queued work somewhere else.
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
    for (const listener of this.listeners) { try { listener(); } catch { /* Views cannot interrupt persistence. */ } }
    return message;
  }
}
