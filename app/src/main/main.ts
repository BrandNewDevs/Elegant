import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppCore } from "../core/app-core.js";
import { formatElapsed } from "../core/elapsed.js";
import { ignoredAppsFile } from "../core/ignored-apps.js";
import { ProcessEngine } from "../engine/process-engine.js";
import { createEngineTranscriber } from "../pipeline/engine-transcriber.js";
import { checkOllama, OllamaClient } from "../pipeline/ollama.js";
import { createGroundedSummariser } from "../pipeline/grounded-summariser.js";
import { Setup } from "../setup/setup.js";
import { openStore } from "../store/store.js";
import { DISPLAY_NAME, SPEECH_MODEL } from "../config.js";
import { showPrompt } from "./prompt-window.js";
import { MeetingsWindow } from "./meetings-window.js";
import { OnboardingWindow } from "./onboarding-window.js";
import { SetupBridge } from "./setup-bridge.js";
import { STATUS_LABEL } from "./status-label.js";

const RECORDING_SYMBOL = "⏺";

// Dev location of the engine built by `pnpm run build:engine`. Packaging will change this.
const devEngine = fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

let tray: Tray | undefined;
let core: AppCore | undefined;
let prompt: { close(): void } | undefined;
let meetingsWindow: MeetingsWindow | undefined;

let ignoredAppsPath = "";

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
      { label: "Meetings…", click: () => meetingsWindow?.show("meetings") },
      { label: "Settings…", accelerator: "Command+,", click: () => meetingsWindow?.show("settings") },
      {
        label: "Keep audio after transcription",
        type: "checkbox",
        checked: core.keepAudio,
        click: (item) => {
          core?.setKeepAudio(item.checked);
          render();
        },
      },
      { label: "Ignored apps…", click: () => void shell.openPath(ignoredAppsPath) },
      {
        label: "Never prompt for",
        enabled: core.neverApps.length > 0,
        // Choosing an app undoes Never for it.
        submenu: core.neverApps.map((name) => ({
          label: name,
          click: () => {
            core?.allowApp(name);
            render();
          },
        })),
      },
      { label: `Quit ${DISPLAY_NAME}`, role: "quit" },
    ]),
  );
}

// One instance owns the engine, the store and the microphone watch. Launching again just brings its window forward.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
app.on("second-instance", () => meetingsWindow?.show());
app.on("activate", () => meetingsWindow?.show());

app.whenReady().then(() => {
  if (!isFirstInstance) return; // quitting; must not start a second engine
  app.dock?.hide(); // a menu-bar app has no dock icon
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });

  const store = openStore(join(dataDir, "meetings.db"));
  const engine = new ProcessEngine({ command: process.env.MEETING_RECORDER_ENGINE ?? devEngine });
  ignoredAppsPath = join(dataDir, "ignored-apps.json");
  core = new AppCore({
    engine,
    store,
    extraIgnoredApps: ignoredAppsFile(ignoredAppsPath),
    pipeline: {
      transcribe: createEngineTranscriber(engine, { model: SPEECH_MODEL, modelsDirectory: join(dataDir, "models") }),
      summarise: createGroundedSummariser({ model: new OllamaClient() }),
    },
  });

  const setup = new Setup(engine, store, {
    jobs: core.jobs,
    speechModel: SPEECH_MODEL,
    modelsDirectory: join(dataDir, "models"),
    checkOllama: () => checkOllama(),
  });
  const setupBridge = new SetupBridge(setup, {
    done: (sender) => BrowserWindow.fromWebContents(sender)?.close(),
    openSettings: () => meetingsWindow?.show("settings"),
  });
  meetingsWindow = new MeetingsWindow(core, setup, setupBridge);
  const onboardingWindow = new OnboardingWindow(setupBridge);

  tray = new Tray(nativeImage.createEmpty());
  core.onDetectedMeetingChange((meeting) => {
    prompt?.close(); // the Meeting was answered, timed out or ended; the old overlay is stale
    prompt = undefined;
    if (!meeting) return;
    console.log(`[detection] ${meeting.app}`);
    prompt = showPrompt(meeting.app, {
      record: () => core!.acceptPrompt(),
      notNow: () => core!.declinePrompt(),
      never: () => {
        core!.neverForThisApp();
        render();
      },
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
  core.onStopNudge((callApp) => {
    // A reminder only: the Recording keeps running until Stop is pressed in the menu bar.
    new Notification({
      title: `${callApp} has stopped using the microphone`,
      body: `${DISPLAY_NAME} is still recording. Choose Stop recording in the menu bar when the call is over.`,
    }).show();
  });
  core.onRecordingChange((recording) => {
    clearInterval(elapsedTimer);
    // The tray shows elapsed seconds, so it redraws every second for as long as the Recording runs.
    elapsedTimer = recording ? setInterval(render, 1000) : undefined;
    render();
  });
  render();
  core.start();
  // Opened by hand, the app shows its window, since the menu-bar item alone is easy to miss. Opened at login it stays quiet.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) meetingsWindow.show();
  // Permissions that were granted before are checked silently once the engine is up. Onboarding opens only when one is
  // missing, even at login, because nothing can be recorded without them.
  setup.onPermissionsChecked(() => {
    if (!setup.permissionsGranted) onboardingWindow.show();
  });

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
