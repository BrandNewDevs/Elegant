export type AIProvider = "ollama" | "gemini";

/** Saved credentials are never part of renderer state. */
export interface AISettingsView {
  provider: AIProvider;
  geminiModel: string;
  hasGeminiKey: boolean;
}

export type AISettingsAction =
  | { type: "select"; provider: AIProvider; consent?: boolean }
  | { type: "save-key"; key: string }
  | { type: "remove-key" }
  | { type: "model"; model: string }
  | { type: "test" };
