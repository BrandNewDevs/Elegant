import { BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import type { FirstRunSetup } from "../setup/first-run-setup.js";
import { DISPLAY_NAME } from "../config.js";
import type { SetupAction } from "../shared/setup-actions.js";
import type { SetupViewState } from "../shared/setup-view-state.js";
import { preloadPath, rendererPagePath } from "./window-ui.js";

const SETTINGS_PANE = {
  "settings-microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "settings-system-audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

/** The first-run setup window. React UI talks to the main process over IPC. */
export class SetupWindow {
  private window: BrowserWindow | undefined;
  private pageLoaded = false;

  constructor(private readonly setup: FirstRunSetup) {
    setup.onChange(() => this.pushState());
    ipcMain.on("setup:ready", (event) => {
      if (!this.fromThis(event.sender)) return;
      this.pushState();
    });
    ipcMain.on("setup:act", (event, action: SetupAction) => {
      if (!this.fromThis(event.sender)) return;
      this.act(action);
    });
  }

  private fromThis(sender: WebContents): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && sender === this.window.webContents);
  }

  show(): void {
    if (!this.window) {
      const window = new BrowserWindow({
        width: 560,
        height: 720,
        title: `${DISPLAY_NAME}: Set up`,
        webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true },
      });
      window.on("closed", () => {
        this.window = undefined;
        this.pageLoaded = false;
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.window = window;
      void this.window.loadFile(rendererPagePath("setup"));
      this.window.webContents.once("did-finish-load", () => {
        this.pageLoaded = true;
        this.pushState();
      });
      void this.setup.checkOllama();
    } else if (this.pageLoaded) {
      this.pushState();
    }
    this.window.show();
    this.window.focus();
  }

  private act(action: SetupAction | undefined): void {
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
      case "done":
        return this.window?.close();
    }
  }

  private pushState(): void {
    if (!this.window || this.window.isDestroyed() || !this.pageLoaded) return;
    const payload: SetupViewState = { name: DISPLAY_NAME, complete: this.setup.complete, state: this.setup.state };
    this.window.webContents.send("setup:state", payload);
  }
}
