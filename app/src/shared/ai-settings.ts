export type AIProvider = "ollama" | "gemini";

/** Saved credentials are never part of renderer state. */
export interface AISettingsView {
  provider: AIProvider;
  geminiModel: string;
  hasGeminiKey: boolean;
  /** The models that answered the last "find usable models" run, if one was done for this key. Absent in older fixtures. */
  usableModels?: string[];
  /** Set while that run is going on: how many models have been tried of how many. */
  finding?: { done: number; total: number };
}

export type AISettingsAction =
  | { type: "select"; provider: AIProvider; consent?: boolean }
  | { type: "save-key"; key: string }
  | { type: "remove-key" }
  | { type: "model"; model: string }
  | { type: "test" };

/** A Gemini text model the account can use. `id` is what is saved and sent; `label` is Google's name for it. */
export interface GeminiModelOption {
  id: string;
  label: string;
}
