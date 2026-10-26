import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { writeFile } from "node:fs/promises";
import type { AppCore } from "../core/app-core.js";
import { DISPLAY_NAME } from "../config.js";
import type { MeetingsViewState } from "../shared/meetings-view-state.js";
import { preloadPath, rendererPagePath, windowBackground } from "./window-ui.js";

type MeetingAction = { type: "regenerate" | "delete"; id: number };

/** The Meetings window: a list on the left, the selected Meeting on the right. Redraws when Meetings change. */
export class MeetingsWindow {
  private window: BrowserWindow | undefined;
  private selectedId: number | undefined;
  private query = "";
  private pageLoaded = false;

  constructor(private readonly core: AppCore) {
    core.onMeetingsChanged(() => this.pushState());
    this.registerIpc();
  }

  private fromThis(sender: WebContents): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && sender === this.window.webContents);
  }

  private registerIpc(): void {
    ipcMain.on("meetings:ready", (event) => {
      if (!this.fromThis(event.sender)) return;
      this.pushState();
    });
    ipcMain.on("meetings:select", (event, id: number) => {
      if (!this.fromThis(event.sender)) return;
      this.selectedId = id;
      this.pushState();
    });
    ipcMain.on("meetings:search", (event, query: string) => {
      if (!this.fromThis(event.sender)) return;
      this.query = query;
      this.pushState();
    });
    ipcMain.on("meetings:rename", (event, payload: { meetingId: number; label: string; name: string }) => {
      if (!this.fromThis(event.sender)) return;
      try {
        this.core.renameParticipant(payload.meetingId, payload.label, payload.name);
      } catch (err) {
        console.error("[meetings] rename failed", err);
      }
    });
    ipcMain.on("meetings:export", (event, id: number) => {
      if (!this.fromThis(event.sender)) return;
      void this.export(id);
    });
    ipcMain.handle("meetings:regenerate", async (event, id: number) => {
      if (!this.fromThis(event.sender)) return;
      try {
        await this.core.regenerateSummary(id);
      } catch (err) {
        dialog.showErrorBox("Could not regenerate the Meeting", err instanceof Error ? err.message : String(err));
      }
    });
    ipcMain.handle("meetings:delete", async (event, id: number) => {
      if (!this.fromThis(event.sender)) return;
      await this.perform({ type: "delete", id });
    });
  }

  /** Shows the window, creating it the first time or after it was closed. */
  show(): void {
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
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
    const payload: MeetingsViewState = { meetings, selected, query: this.query };
    this.window.webContents.send("meetings:state", payload);
  }
}
