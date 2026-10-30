/// <reference types="vite/client" />

import type { MeetingsApi } from "../shared/meetings-api";
import type { SetupAction } from "../shared/setup-actions";
import type { SetupViewState } from "../shared/setup-view-state";
import type { PromptChoice } from "../shared/prompt-choice";
import type { AISettingsAction } from "../shared/ai-settings";

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
