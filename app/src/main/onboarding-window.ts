import { BrowserWindow } from "electron";
import { DISPLAY_NAME } from "../config.js";
import type { SetupBridge } from "./setup-bridge.js";
import { preloadPath, rendererPagePath, windowBackground } from "./window-ui.js";

/** The first-run onboarding window. It opens only when a permission is missing; its page talks to the Setup through the bridge. */
export class OnboardingWindow {
  private window: BrowserWindow | undefined;

  constructor(private readonly bridge: SetupBridge) {}

  show(): void {
    if (!this.window) {
      const window = new BrowserWindow({
        width: 520,
        height: 640,
        title: `${DISPLAY_NAME}: Welcome`,
        backgroundColor: windowBackground(),
        webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true },
      });
      window.on("closed", () => {
        this.window = undefined;
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.bridge.attach(window.webContents);
      this.window = window;
      void window.loadFile(rendererPagePath("onboarding"));
    }
    this.window.show();
    this.window.focus();
  }
}
