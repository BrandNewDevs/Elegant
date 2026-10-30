/// <reference types="vite/client" />

import type { MeetingsApi } from "../shared/meetings-api";
import type { SetupAction } from "../shared/setup-actions";
import type { SetupViewState } from "../shared/setup-view-state";
import type { PromptChoice } from "../shared/prompt-choice";
import type { AISettingsAction, GeminiModelOption } from "../shared/ai-settings";

declare global {
  interface Window {
    electron: {
      meetings: MeetingsApi;
      setup: {
        ready(): void;
        onState(callback: (state: SetupViewState) => void): () => void;
        act(action: SetupAction): void;
        setUserName(name: string): void;
        configureAI(action: AISettingsAction): Promise<string>;
        /** The Gemini text models the saved key can use. */
        geminiModels(): Promise<GeminiModelOption[]>;
        /** Tries each model with a tiny synthetic request and remembers the ones that answer; resolves when done or stopped. */
        findGeminiModels(): Promise<string>;
        stopFindingGeminiModels(): Promise<void>;
      };
      prompt: {
        ready(): void;
        onState(callback: (state: { app: string }) => void): () => void;
        choose(choice: PromptChoice): void;
        resize(height: number): void;
      };
    };
  }
}

export {};
