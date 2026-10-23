import { app, Menu, nativeImage, Tray } from "electron";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppCore, type EngineStatus } from "../core/app-core.js";
import { ProcessEngine } from "../engine/process-engine.js";
import { unimplementedPipeline } from "../pipeline/unimplemented.js";
import { openStore } from "../store/store.js";
import { DISPLAY_NAME } from "../config.js";
import { STATUS_LABEL } from "./status-label.js";

// Dev location of the engine built by `pnpm run build:engine`. Packaging will change this.
const devEngine = fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

let tray: Tray | undefined;
let core: AppCore | undefined;

function render(status: EngineStatus): void {
  if (!tray) return;
  const { symbol, text } = STATUS_LABEL[status];
  tray.setTitle(symbol);
  tray.setToolTip(`${DISPLAY_NAME}: ${text}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: text, enabled: false },
      { type: "separator" },
      { label: `Quit ${DISPLAY_NAME}`, role: "quit" },
    ]),
  );
  console.log(`[status] ${status}`);
}

app.whenReady().then(() => {
  app.dock?.hide(); // a menu-bar app has no dock icon
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });

  const store = openStore(join(dataDir, "meetings.db"));
  const engine = new ProcessEngine({ command: process.env.MEETING_RECORDER_ENGINE ?? devEngine });
  core = new AppCore({ engine, store, pipeline: unimplementedPipeline });

  tray = new Tray(nativeImage.createEmpty());
  core.onStatusChange(render);
  render(core.status);
  core.start();

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void core!.stop().finally(() => {
      store.close();
      app.exit(0);
    });
  });
});

// No windows yet; the app lives in the menu bar until the user quits.
app.on("window-all-closed", () => {});
