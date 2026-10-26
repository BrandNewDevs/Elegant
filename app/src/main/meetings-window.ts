import { BrowserWindow, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import type { AppCore } from "../core/app-core.js";
import { DISPLAY_NAME } from "../config.js";
import { exportIdFromLink, meetingActionFromLink, meetingIdFromLink, renameFromLink, renderMeetingsPage, searchFromLink, type MeetingAction } from "./meetings-page.js";

/** The Meetings window: a list on the left, the selected Meeting on the right. Redraws when Meetings change. */
export class MeetingsWindow {
  private window: BrowserWindow | undefined;
  private selectedId: number | undefined;
  private query = "";

  constructor(private readonly core: AppCore) {
    core.onMeetingsChanged(() => this.draw());
  }

  /** Shows the window, creating it the first time or after it was closed. */
  show(): void {
    if (!this.window) {
      const window = new BrowserWindow({ width: 900, height: 640, title: `${DISPLAY_NAME}: Meetings` });
      window.on("closed", () => (this.window = undefined));
      // The page is plain HTML; clicking a Meeting navigates to its link, which we turn into a selection.
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        const exportId = exportIdFromLink(url);
        if (exportId !== undefined) {
          void this.export(exportId);
          return;
        }
        const action = meetingActionFromLink(url);
        if (action) return void this.perform(action, window);
        const query = searchFromLink(url);
        if (query !== undefined) {
          this.query = query;
          this.draw();
          return;
        }
        const rename = renameFromLink(url);
        if (rename) {
          try {
            this.core.renameParticipant(rename.meetingId, rename.label, rename.name);
          } catch (err) {
            console.error("[meetings] rename failed", err);
          }
          return; // the rename redraws the window through onMeetingsChanged
        }
        const id = meetingIdFromLink(url);
        if (id === undefined) return;
        this.selectedId = id;
        this.draw();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      this.window = window;
      this.draw();
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

  private async perform({ type, id }: MeetingAction, window: BrowserWindow): Promise<void> {
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
      this.draw();
    } catch (err) {
      dialog.showErrorBox(`Could not ${type} the Meeting`, err instanceof Error ? err.message : String(err));
    }
  }

  private draw(): void {
    if (!this.window) return;
    const selected = this.selectedId === undefined ? undefined : this.core.getMeetingForDisplay(this.selectedId);
    const html = renderMeetingsPage(this.query.trim() ? this.core.searchMeetings(this.query) : this.core.listMeetings(), selected, this.query);
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}
