/// <reference types="vite/client" />

import type { MeetingsView, MeetingsViewState } from "../shared/meetings-view-state";
import type { SetupAction } from "../shared/setup-actions";
import type { SetupViewState } from "../shared/setup-view-state";
import type { PromptChoice } from "../shared/prompt-choice";

declare global {
  interface Window {
    electron: {
      meetings: {
        ready(): void;
        onState(callback: (state: MeetingsViewState) => void): () => void;
        view(view: MeetingsView): void;
        select(id: number): void;
        search(query: string): void;
        rename(payload: { meetingId: number; label: string; name: string }): void;
        export(id: number): void;
        regenerate(id: number): Promise<void>;
        delete(id: number): Promise<void>;
      };
      setup: {
        ready(): void;
        onState(callback: (state: SetupViewState) => void): () => void;
        act(action: SetupAction): void;
        setUserName(name: string): void;
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
