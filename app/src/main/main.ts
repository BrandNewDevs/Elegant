import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AppCore } from "../core/app-core.js";
import { formatElapsed } from "../core/elapsed.js";
import { ignoredAppsFile } from "../core/ignored-apps.js";
import { checkForUpdate } from "../core/update-check.js";
import { ProcessEngine } from "../engine/process-engine.js";
import { createEngineTranscriber } from "../pipeline/engine-transcriber.js";
import { createMeetingChat } from "../pipeline/meeting-chat.js";
import { checkOllama, OllamaClient, DEFAULT_SUMMARY_MODEL } from "../pipeline/ollama.js";
import { createReadableSummariser } from "../pipeline/readable-summariser.js";
import { Setup } from "../setup/setup.js";
import { openStore } from "../store/store.js";
import { DISPLAY_NAME, RELEASES_REPO, SPEECH_MODEL } from "../config.js";
import { showPrompt } from "./prompt-window.js";
import { Launch } from "./launch.js";
import { MeetingsWindow } from "./meetings-window.js";
import { OnboardingWindow } from "./onboarding-window.js";
import { SetupBridge } from "./setup-bridge.js";
import { STATUS_LABEL } from "./status-label.js";

const RECORDING_SYMBOL = "⏺";

// `pnpm run package` embeds the engine at Contents/Helpers; from source it is the one `pnpm run build:engine` built.
const engineCommand = app.isPackaged
  ? join(process.resourcesPath, "../Helpers/engine")
  : fileURLToPath(new URL("../../../engine/.build/release/engine", import.meta.url));

let tray: Tray | undefined;
let core: AppCore | undefined;
let prompt: { close(): void } | undefined;
let meetingsWindow: MeetingsWindow | undefined;
let launch: Launch | undefined;

let ignoredAppsPath = "";

let elapsedTimer: ReturnType<typeof setInterval> | undefined;

// The packaged Info.plist sets LSUIElement, so the app starts with no Dock icon; showing it switches the running app to
// a regular one, and hiding it switches it back, with no restart.
function applyShowInDock(show: boolean): void {
  if (show) void app.dock?.show();
  else app.dock?.hide();
}

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
      { label: `Open ${DISPLAY_NAME}`, click: () => launch?.open() },
      { label: "Settings…", accelerator: "Command+,", click: () => meetingsWindow?.show({ settings: true }) },
      {
        label: "Keep audio after transcription",
        type: "checkbox",
        checked: core.keepAudio,
        click: (item) => {
          core?.setKeepAudio(item.checked);
          render();
        },
      },
      {
        label: "Show in Dock",
        type: "checkbox",
        checked: core.showInDock,
        click: (item) => core?.setShowInDock(item.checked),
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
app.on("second-instance", () => launch?.open());
app.on("activate", () => launch?.activate());

app.whenReady().then(() => {
  if (!isFirstInstance) return; // quitting; must not start a second engine
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });

  const store = openStore(join(dataDir, "meetings.db"));
  const engine = new ProcessEngine({ command: process.env.MEETING_RECORDER_ENGINE ?? engineCommand });
  ignoredAppsPath = join(dataDir, "ignored-apps.json");
  const textModel = new OllamaClient();
  core = new AppCore({
    chat: createMeetingChat({ store, model: textModel, modelName: DEFAULT_SUMMARY_MODEL }),
    engine,
    store,
    extraIgnoredApps: ignoredAppsFile(ignoredAppsPath),
    pipeline: {
      transcribe: createEngineTranscriber(engine, { model: SPEECH_MODEL, modelsDirectory: join(dataDir, "models") }),
      summarise: createReadableSummariser({ model: textModel }),
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
    openSettings: () => meetingsWindow?.show({ settings: true }),
  });
  meetingsWindow = new MeetingsWindow(core, setup, setupBridge);
  const onboardingWindow = new OnboardingWindow(setupBridge);
  launch = new Launch(setup, meetingsWindow, onboardingWindow, app.getLoginItemSettings().wasOpenedAtLogin);

  // A menu-bar app at start (LSUIElement); the "Show in Dock" setting, on unless turned off, adds a Dock icon, whose click opens the main window ("activate").
  applyShowInDock(core.showInDock);
  core.onShowInDockChange((show) => {
    applyShowInDock(show);
    render();
  });

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
  core.onEngineProblem((message) => {
    console.error(`[engine] ${message}`);
    new Notification({ title: `${DISPLAY_NAME} has an audio problem`, body: message }).show();
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
  // The installed app launches at login. It registers only while it has never been registered ("not-found" before the
  // first registration), so once the user turns it off in System Settings ("requires-approval") it stays off. A run
  // from source would register the bare Electron binary, so it never registers.
  if (app.isPackaged) {
    const { status } = app.getLoginItemSettings();
    if (status === "not-registered" || status === "not-found") app.setLoginItemSettings({ openAtLogin: true });
    console.log(`[login item] ${app.getLoginItemSettings().status}`);
  }
  // Permissions that were granted before are checked silently once the engine is up. Onboarding opens only when one is
  // missing, even at login, and on a first launch it opens before the Meetings window does.
  launch.start();
  // A run from source never checks. The toast waits for the Meetings window; nothing opens one for it.
  if (app.isPackaged) {
    void checkForUpdate({
      currentVersion: app.getVersion(),
      repo: RELEASES_REPO,
      userAgent: `${DISPLAY_NAME}/${app.getVersion()}`,
      fetch,
      enabled: () => core!.checkForUpdates,
      lastNotified: () => core!.lastNotifiedUpdate,
    }).then((update) => update && meetingsWindow?.offerUpdate(update));
  }

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
