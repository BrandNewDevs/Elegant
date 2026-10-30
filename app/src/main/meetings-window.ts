import { BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import type { AppCore } from "../core/app-core.js";
import { DISPLAY_NAME } from "../config.js";
import { isGithubUrl } from "../core/update-check.js";
import type { Updater, UpdateState } from "../core/updater.js";
import type { Setup } from "../setup/setup.js";
import { isAppearance } from "../shared/appearance.js";
import { isModelName } from "../shared/summary-model.js";
import { MODEL_KINDS, type ModelKind } from "../shared/model-kinds.js";
import { listOllamaModels } from "../pipeline/ollama.js";
import type { MeetingsViewState } from "../shared/meetings-view-state.js";
import type { SetupBridge } from "./setup-bridge.js";
import { preloadPath, rendererPagePath, windowBackground } from "./window-ui.js";

type MeetingAction = { type: "regenerate" | "delete"; id: number };

const validMeetingId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function meetingId(value: unknown): number {
  if (!validMeetingId(value)) throw new Error("Invalid Meeting ID");
  return value;
}
function payload(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid Meeting request");
  return value as Record<string, unknown>;
}
function requestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid chat request ID");
  return value;
}
function question(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error("Questions must contain between 1 and 2000 characters");
  return value;
}
function reference(value: unknown): { meetingId: number; revision: string; refs: number[] } {
  const input = payload(value, ["meetingId", "revision", "refs"]);
  if (typeof input.revision !== "string" || !/^[a-f0-9]{64}$/i.test(input.revision)) throw new Error("Invalid Transcript revision");
  if (!Array.isArray(input.refs) || !input.refs.length || input.refs.length > 4096
    || input.refs.some(ref => !Number.isSafeInteger(ref) || ref < 0) || new Set(input.refs).size !== input.refs.length) {
    throw new Error("References must contain 1 to 4096 distinct segment numbers");
  }
  return { meetingId: meetingId(input.meetingId), revision: input.revision.toLowerCase(), refs: input.refs as number[] };
}

/**
 * The main window: the Meetings (a list on the left, the selected Meeting on the right), with the Settings dialog over them
 * when it is open. Redraws when Meetings change.
 */
const isModelKind = (value: unknown): value is ModelKind => (MODEL_KINDS as readonly unknown[]).includes(value);

export class MeetingsWindow {
  private window: BrowserWindow | undefined;
  private settingsOpen = false;
  private selectedId: number | undefined;
  private query = "";
  private pageLoaded = false;
  /** Whether the page has subscribed to the push channels, so a message sent now is not lost. */
  private rendererReady = false;
  /** The latest news about an update that no window has shown yet, held until one can. */
  private pendingUpdate: Exclude<UpdateState, { status: "idle" }> | undefined;
  /** The release page of the update that failed, the only page "View release" opens. */
  private failedReleaseUrl: string | undefined;

  /** `updater` is absent in a run from source, which never updates. */
  constructor(
    private readonly core: AppCore,
    private readonly setup: Setup,
    private readonly bridge: SetupBridge,
    private readonly updater?: Updater,
    private readonly appVersion?: string,
  ) {
    updater?.onChange(state => {
      this.offerUpdate(state);
      this.pushState();
    });
    core.onRecordingChange(() => this.pushState());
    core.onMeetingsChanged(() => this.pushState());
    core.onShowInDockChange(() => this.pushState());
    core.onAppearanceChange(() => this.pushState());
    core.onSummaryModelChange(() => this.pushState());
    core.onKeepAudioChange(() => this.pushState());
    core.onChatChanged(() => this.pushState());
    core.jobs.onChange(() => this.pushState());
    setup.onUserNameChange(() => this.pushState());
    this.registerIpc();
  }

  private fromThis(sender: WebContents): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && sender === this.window.webContents);
  }

  private requireFromThis(sender: WebContents): void {
    if (!this.fromThis(sender)) throw new Error("This window cannot access Meetings");
  }

  private registerIpc(): void {
    ipcMain.on("meetings:ready", (event) => {
      if (!this.fromThis(event.sender)) return;
      this.rendererReady = true;
      this.pushState();
      this.announceUpdate();
    });
    ipcMain.on("meetings:settings", (event, open: boolean) => {
      if (!this.fromThis(event.sender) || typeof open !== "boolean") return;
      this.setSettingsOpen(open);
    });
    ipcMain.on("meetings:show-in-dock", (event, show: unknown) => {
      if (!this.fromThis(event.sender) || typeof show !== "boolean") return;
      this.core.setShowInDock(show);
    });
    ipcMain.on("meetings:appearance", (event, appearance: unknown) => {
      if (!this.fromThis(event.sender) || !isAppearance(appearance)) return;
      this.core.setAppearance(appearance);
    });
    ipcMain.on("meetings:summary-model", (event, model: unknown) => {
      if (!this.fromThis(event.sender) || !isModelName(model)) return;
      this.core.setSummaryModel(model);
    });
    ipcMain.handle("meetings:model-files", (event) => {
      this.requireFromThis(event.sender);
      return this.setup.listModels();
    });
    ipcMain.handle("meetings:remove-model", (event, kind: unknown) => {
      this.requireFromThis(event.sender);
      return isModelKind(kind) ? this.setup.removeModel(kind) : { ok: false as const, reason: "Unknown model." };
    });
    ipcMain.handle("meetings:redownload-model", (event, kind: unknown) => {
      this.requireFromThis(event.sender);
      return isModelKind(kind) ? this.setup.redownloadModel(kind) : { ok: false as const, reason: "Unknown model." };
    });
    ipcMain.handle("meetings:installed-models", (event) => {
      this.requireFromThis(event.sender);
      return listOllamaModels();
    });
    ipcMain.on("meetings:keep-audio", (event, keep: unknown) => {
      if (!this.fromThis(event.sender) || typeof keep !== "boolean") return;
      this.core.setKeepAudio(keep);
    });
    ipcMain.on("meetings:check-for-updates", (event, check: unknown) => {
      if (!this.fromThis(event.sender) || typeof check !== "boolean") return;
      this.core.setCheckForUpdates(check);
      this.pushState();
    });
    ipcMain.on("meetings:stop-recording", (event) => {
      if (this.fromThis(event.sender)) this.core.stopRecording();
    });
    ipcMain.on("meetings:open-release", (event) => {
      if (!this.fromThis(event.sender) || !isGithubUrl(this.failedReleaseUrl)) return;
      void shell.openExternal(this.failedReleaseUrl);
    });
    ipcMain.handle("meetings:restart-for-update", (event) => {
      this.requireFromThis(event.sender);
      return this.updater?.restart() ?? { ok: false, reason: "This copy of the app does not update itself." };
    });
    ipcMain.on("meetings:select", (event, id: number) => {
      if (!this.fromThis(event.sender) || !validMeetingId(id)) return;
      this.selectedId = id;
      this.pushState();
    });
    ipcMain.on("meetings:search", (event, query: string) => {
      if (!this.fromThis(event.sender) || typeof query !== "string" || query.length > 2000) return;
      this.query = query;
      this.pushState();
    });
    ipcMain.on("meetings:rename", (event, payload: { meetingId: number; label: string; name: string }) => {
      if (!this.fromThis(event.sender) || !payload || !validMeetingId(payload.meetingId)
        || typeof payload.label !== "string" || !payload.label || payload.label.length > 100
        || typeof payload.name !== "string" || payload.name.length > 100) return;
      try {
        this.core.renameParticipant(payload.meetingId, payload.label, payload.name);
      } catch (err) {
        console.error("[meetings] rename failed", err);
      }
    });
    ipcMain.on("meetings:export", (event, id: number) => {
      if (!this.fromThis(event.sender) || !validMeetingId(id)) return;
      void this.export(id);
    });
    ipcMain.handle("meetings:regenerate", async (event, id: number) => {
      this.requireFromThis(event.sender);
      meetingId(id);
      try {
        await this.core.regenerateSummary(id);
      } catch (err) {
        dialog.showErrorBox("Could not regenerate the Meeting", err instanceof Error ? err.message : String(err));
      }
    });
    ipcMain.handle("meetings:delete", async (event, id: number) => {
      this.requireFromThis(event.sender);
      meetingId(id);
      await this.perform({ type: "delete", id });
    });
    ipcMain.handle("meetings:send-question", (event, value: unknown) => {
      this.requireFromThis(event.sender);
      const input = payload(value, ["meetingId", "requestId", "question"]);
      this.core.sendQuestion(meetingId(input.meetingId), requestId(input.requestId), question(input.question));
    });
    ipcMain.handle("meetings:cancel-question", (event, value: unknown) => {
      this.requireFromThis(event.sender);
      const input = payload(value, ["meetingId", "requestId"]);
      this.core.cancelQuestion(meetingId(input.meetingId), requestId(input.requestId));
    });
    ipcMain.handle("meetings:clear-chat", (event, id: unknown) => {
      this.requireFromThis(event.sender);
      this.core.clearChat(meetingId(id));
    });
    ipcMain.handle("meetings:open-reference", (event, value: unknown) => {
      this.requireFromThis(event.sender);
      const input = reference(value);
      return this.core.openReference(input.meetingId, { revision: input.revision, refs: input.refs });
    });
    ipcMain.handle("meetings:cancel-job", (event, value: unknown) => {
      this.requireFromThis(event.sender);
      const input = payload(value, ["meetingId", "jobId"]);
      const id = meetingId(input.meetingId);
      if (typeof input.jobId !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(input.jobId)) throw new Error("Invalid AI job ID");
      const job = this.core.jobs.snapshot.find(job => job.id === input.jobId);
      if (!job) throw new Error("This AI job is no longer queued or running");
      if (job.owner !== `meeting:${id}` && job.owner !== `chat:${id}`) throw new Error("This AI job does not belong to this Meeting");
      if (job.status !== "queued" && job.kind !== "summary" && job.kind !== "meeting-chat") {
        throw new Error("Active transcription cannot be cancelled from this window");
      }
      this.core.jobs.cancel(job.id);
    });
  }

  /** Shows the window, creating it the first time or after it was closed. `settings` opens or closes the Settings dialog first. */
  show(options: { settings?: boolean } = {}): void {
    if (options.settings !== undefined) this.setSettingsOpen(options.settings, false);
    if (!this.window) {
      const window = new BrowserWindow({
        width: 900,
        height: 640,
        title: `${DISPLAY_NAME}: Meetings`,
        backgroundColor: windowBackground(),
        webPreferences: { preload: preloadPath(), contextIsolation: true, sandbox: true },
      });
      window.on("closed", () => {
        this.window = undefined;
        this.pageLoaded = false;
        this.rendererReady = false;
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.bridge.attach(window.webContents);
      this.window = window;
      void this.window.loadFile(rendererPagePath("meetings"));
      this.window.webContents.once("did-finish-load", () => {
        this.pageLoaded = true;
        this.pushState();
      });
    } else if (this.pageLoaded) {
      this.pushState();
    }
    this.window.show();
    this.window.focus();
  }

  /**
   * News about an update: it is downloading, ready to install, or failed. The toast needs a visible window, so it goes to the
   * open one now, or waits for the next time one opens; this never opens a window itself. Once a release was announced as
   * ready or failed, the person has been told about that version and it is not announced again.
   */
  offerUpdate(update: UpdateState): void {
    if (update.status === "failed") this.failedReleaseUrl = update.url; // the page may ask for it again after the toast is gone
    if (update.status === "idle" || update.version === this.core.lastNotifiedUpdate) return;
    this.pendingUpdate = update;
    this.announceUpdate();
  }

  private announceUpdate(): void {
    const update = this.pendingUpdate;
    if (!update || !this.window || this.window.isDestroyed() || !this.rendererReady) return;
    this.pendingUpdate = undefined;
    if (update.status !== "downloading") this.core.setLastNotifiedUpdate(update.version);
    this.window.webContents.send("meetings:update", update);
  }

  private setSettingsOpen(open: boolean, push = true): void {
    this.settingsOpen = open;
    // The person may have changed a permission in System Settings or started Ollama since Settings was last open.
    if (open) {
      this.setup.verifyPermissions();
      void this.setup.checkOllama();
    }
    if (push) this.pushState();
  }

  private async export(id: number): Promise<void> {
    if (!this.window) return;
    try {
      const { fileName, markdown } = this.core.exportMeeting(id);
      const { canceled, filePath } = await dialog.showSaveDialog(this.window, {
        defaultPath: fileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!canceled && filePath) await writeFile(filePath, markdown);
    } catch (err) {
      dialog.showErrorBox("Could not export the Meeting", err instanceof Error ? err.message : String(err));
    }
  }

  private async perform({ type, id }: MeetingAction): Promise<void> {
    const window = this.window;
    if (!window) return;
    try {
      if (type === "regenerate") {
        await this.core.regenerateSummary(id);
        return;
      }
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        message: "Delete this Meeting?",
        detail: "Its Transcript, Summary, Participants and any kept audio are removed for good.",
        buttons: ["Delete", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return;
      await this.core.deleteMeeting(id);
      if (this.selectedId === id) this.selectedId = undefined;
      this.pushState();
    } catch (err) {
      dialog.showErrorBox(`Could not ${type} the Meeting`, err instanceof Error ? err.message : String(err));
    }
  }

  private pushState(): void {
    if (!this.window || this.window.isDestroyed() || !this.pageLoaded) return;
    const selected = this.selectedId === undefined ? undefined : this.core.getMeetingForDisplay(this.selectedId);
    const meetings = this.query.trim() ? this.core.searchMeetings(this.query) : this.core.listMeetings();
    const payload: MeetingsViewState = {
      settingsOpen: this.settingsOpen,
      showInDock: this.core.showInDock,
      appearance: this.core.appearance,
      summaryModel: this.core.summaryModel,
      keepAudio: this.core.keepAudio,
      checkForUpdates: this.core.checkForUpdates,
      meetings,
      selected,
      query: this.query,
      jobs: this.core.jobs.snapshot,
      recording: this.core.recording,
      update: this.updater?.state ?? { status: "idle" },
      appVersion: this.appVersion,
      ...(selected ? { chat: { history: this.core.getChatHistoryForDisplay(selected.id),
        available: this.core.isChatAvailable(selected.id), revision: this.core.getTranscriptRevision(selected.id) } } : {}),
    };
    this.window.webContents.send("meetings:state", payload);
  }
}
