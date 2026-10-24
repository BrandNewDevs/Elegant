import { app, Menu, nativeImage, Notification, Tray } from "electron";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppCore } from "../core/app-core.js";
import { formatElapsed } from "../core/elapsed.js";
import { ProcessEngine } from "../engine/process-engine.js";
import { OllamaClient } from "../pipeline/ollama.js";
import { createSummariser } from "../pipeline/summariser.js";
import { unimplementedPipeline } from "../pipeline/unimplemented.js";
import { openStore } from "../store/store.js";
import { DISPLAY_NAME } from "../config.js";
import { showPrompt } from "./prompt-window.js";
import { MeetingsWindow } from "./meetings-window.js";
import { STATUS_LABEL } from "./status-label.js";

const RECORDING_SYMBOL = "⏺";

// Dev location of the engine built by `pnpm run build:engine`. Packaging will change this.
const devEngine = fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

let tray: Tray | undefined;
let core: AppCore | undefined;
let prompt: { close(): void } | undefined;
let meetingsWindow: MeetingsWindow | undefined;

let elapsedTimer: ReturnType<typeof setInterval> | undefined;

function render(): void {
  if (!tray || !core) return;
  const { symbol, text } = STATUS_LABEL[core.status];
  const recording = core.recording;
  const elapsed = recording ? formatElapsed(recording.startedAt) : undefined;
  tray.setTitle(recording ? `${RECORDING_SYMBOL} ${elapsed}` : symbol);
  tray.setToolTip(recording ? `${DISPLAY_NAME}: recording ${recording.app}, ${elapsed}` : `${DISPLAY_NAME}: ${text}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(recording
        ? [
            { label: `Recording ${recording.app}: ${elapsed}`, enabled: false },
            { label: "Stop recording", click: () => core?.stopRecording() },
          ]
        : []),
      { label: text, enabled: false },
      { type: "separator" },
      { label: "Meetings…", click: () => meetingsWindow?.show() },
      { label: `Quit ${DISPLAY_NAME}`, role: "quit" },
    ]),
  );
}

app.whenReady().then(() => {
  app.dock?.hide(); // a menu-bar app has no dock icon
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });

  const store = openStore(join(dataDir, "meetings.db"));
  const engine = new ProcessEngine({ command: process.env.MEETING_RECORDER_ENGINE ?? devEngine });
  core = new AppCore({
    engine,
    store,
    pipeline: { ...unimplementedPipeline, summarise: createSummariser({ model: new OllamaClient() }) },
  });

  meetingsWindow = new MeetingsWindow(core);

  tray = new Tray(nativeImage.createEmpty());
  core.onDetectedMeetingChange((meeting) => {
    prompt?.close(); // the Meeting was answered, timed out or ended; the old overlay is stale
    prompt = undefined;
    if (!meeting) return;
    console.log(`[detection] ${meeting.app}`);
    prompt = showPrompt(meeting.app, {
      record: () => core!.acceptPrompt(),
      notNow: () => core!.declinePrompt(),
    });
  });
  core.onStatusChange((status) => {
    console.log(`[status] ${status}`);
    render();
  });
  core.onRecordingFailed((message) => {
    console.error(`[recording] ${message}`);
    new Notification({ title: `${DISPLAY_NAME} could not record`, body: message }).show();
  });
  core.onRecordingChange((recording) => {
    clearInterval(elapsedTimer);
    // The tray shows elapsed seconds, so it redraws every second for as long as the Recording runs.
    elapsedTimer = recording ? setInterval(render, 1000) : undefined;
    render();
  });
  render();
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

// The app lives in the menu bar until the user quits, even with the Meetings window closed.
app.on("window-all-closed", () => {});
