import { BrowserWindow, shell } from "electron";
import type { FirstRunSetup } from "../setup/first-run-setup.js";
import { DISPLAY_NAME } from "../config.js";
import { renderSetupPage, setupActionFromLink } from "./setup-page.js";

const SETTINGS_PANE = {
  "settings-microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "settings-system-audio": "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;

/** The first-run setup window. Its page is plain HTML; the buttons are links that the window turns into actions. */
export class SetupWindow {
  private window: BrowserWindow | undefined;

  constructor(private readonly setup: FirstRunSetup) {
    setup.onChange(() => this.draw());
  }

  show(): void {
    if (!this.window) {
      const window = new BrowserWindow({ width: 560, height: 720, title: `${DISPLAY_NAME}: Set up` });
      window.on("closed", () => (this.window = undefined));
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        this.act(setupActionFromLink(url));
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.window = window;
      this.draw();
      void this.setup.checkOllama();
    }
    this.window.show();
    this.window.focus();
  }

  private act(action: ReturnType<typeof setupActionFromLink>): void {
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

  private draw(): void {
    if (!this.window) return;
    const html = renderSetupPage(this.setup.state, DISPLAY_NAME, this.setup.complete);
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}
