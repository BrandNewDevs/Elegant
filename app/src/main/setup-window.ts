import { BrowserWindow, ipcMain, shell, type WebContents } from "electron";
import type { Setup } from "../setup/setup.js";
import { DISPLAY_NAME } from "../config.js";
import type { SetupAction } from "../shared/setup-actions.js";
import type { SetupViewState } from "../shared/setup-view-state.js";
import { preloadPath, rendererPagePath, windowBackground, type RendererPage } from "./window-ui.js";

const SETTINGS_PANE = {
  "settings-microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "settings-system-audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

export interface SetupWindowOptions {
  /** Which page this window shows: the first-run onboarding or the settings. Both read and act on the same Setup. */
  page: Extract<RendererPage, "onboarding" | "settings">;
  title: string;
  width: number;
  height: number;
  /** Runs each time the window is shown, for example to refresh what the page reports. */
  onShow?: () => void;
  /** Opens the settings window; the onboarding's last step offers it. */
  openSettings?: () => void;
}

/** A window over the Setup: the React page asks for actions over IPC and is sent the state whenever it changes. */
export class SetupWindow {
  private window: BrowserWindow | undefined;
  private pageLoaded = false;

  constructor(
    private readonly setup: Setup,
    private readonly options: SetupWindowOptions,
  ) {
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
        width: this.options.width,
        height: this.options.height,
        title: `${DISPLAY_NAME}: ${this.options.title}`,
        backgroundColor: windowBackground(),
        webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true },
      });
      window.on("closed", () => {
        this.window = undefined;
        this.pageLoaded = false;
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.window = window;
      void this.window.loadFile(rendererPagePath(this.options.page));
      this.window.webContents.once("did-finish-load", () => {
        this.pageLoaded = true;
        this.pushState();
      });
    } else if (this.pageLoaded) {
      this.pushState();
    }
    this.options.onShow?.();
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
      case "open-settings":
        return this.options.openSettings?.();
      case "done":
        return this.window?.close();
    }
  }

  private pushState(): void {
    if (!this.window || this.window.isDestroyed() || !this.pageLoaded) return;
    const payload: SetupViewState = { name: DISPLAY_NAME, permissionsGranted: this.setup.permissionsGranted, state: this.setup.state };
    this.window.webContents.send("setup:state", payload);
  }
}
