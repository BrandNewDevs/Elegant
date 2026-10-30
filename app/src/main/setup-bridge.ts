import { ipcMain, shell, type WebContents } from "electron";
import { DISPLAY_NAME } from "../config.js";
import type { Setup } from "../setup/setup.js";
import type { SetupAction } from "../shared/setup-actions.js";
import type { SetupViewState } from "../shared/setup-view-state.js";
import type { AISettings } from "../setup/ai-settings.js";

const SETTINGS_PANE = {
  "settings-microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "settings-system-audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export interface SetupBridgeHandlers {
  ai?: AISettings;
  /** The onboarding page is finished; close the window it is in. */
  done(sender: WebContents): void;
  /** The onboarding page asked to go to Settings, which is a page of the Meetings window. */
  openSettings(): void;
}

/**
 * Serves the Setup to the pages that show it: the onboarding window and the Settings page of the Meetings window. A page is
 * sent the state when it says it is ready and again whenever the state changes, and may ask for actions over IPC. Only
 * web contents that were attached are listened to.
 */
export class SetupBridge {
  /** The attached web contents, and whether each has said it is ready for state. */
  private readonly clients = new Map<WebContents, boolean>();

  constructor(
    private readonly setup: Setup,
    private readonly handlers: SetupBridgeHandlers,
  ) {
    setup.onChange(() => {
      for (const [contents, ready] of this.clients) if (ready) this.push(contents);
    });
    if (handlers.ai) {
      handlers.ai.onChange(() => {
        for (const [contents, ready] of this.clients) if (ready) this.push(contents);
      });
      ipcMain.handle("setup:configure-ai", (event, action: unknown) => {
        if (!this.clients.has(event.sender)) throw new Error("This window cannot configure AI");
        return handlers.ai!.configure(action);
      });
    }
    ipcMain.on("setup:ready", (event) => {
      if (!this.clients.has(event.sender)) return;
      this.clients.set(event.sender, true);
      this.push(event.sender);
    });
    ipcMain.on("setup:set-user-name", (event, name: unknown) => {
      if (!this.clients.has(event.sender) || typeof name !== "string") return;
      this.setup.setUserName(name.slice(0, 100));
    });
    ipcMain.on("setup:act", (event, action: SetupAction) => {
      if (!this.clients.has(event.sender)) return;
      this.act(action, event.sender);
    });
  }

  attach(contents: WebContents): void {
    this.clients.set(contents, false);
    contents.once("destroyed", () => this.clients.delete(contents));
  }

  private act(action: SetupAction | undefined, sender: WebContents): void {
    switch (action) {
      case "microphone":
        return this.setup.requestMicrophone();
      case "system-audio":
        return this.setup.requestSystemAudio();
      case "models":
        return this.setup.downloadModels();
      case "ollama":
        return void this.setup.checkOllama();
      case "settings-microphone":
      case "settings-system-audio":
        return void shell.openExternal(SETTINGS_PANE[action]);
      case "open-settings":
        return this.handlers.openSettings();
      case "done":
        return this.handlers.done(sender);
    }
  }

  private push(contents: WebContents): void {
    if (contents.isDestroyed()) return;
    const payload: SetupViewState = {
      name: DISPLAY_NAME,
      userName: this.setup.userName,
      permissionsGranted: this.setup.permissionsGranted,
      state: this.setup.state,
      ...(this.handlers.ai ? { ai: this.handlers.ai.view } : {}),
    };
    contents.send("setup:state", payload);
  }
}
