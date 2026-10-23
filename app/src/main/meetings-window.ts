import { BrowserWindow } from "electron";
import type { AppCore } from "../core/app-core.js";
import { DISPLAY_NAME } from "../config.js";
import { meetingIdFromLink, renderMeetingsPage } from "./meetings-page.js";

/** The Meetings window: a list on the left, the selected Meeting on the right. Redraws when Meetings change. */
export class MeetingsWindow {
  private window: BrowserWindow | undefined;
  private selectedId: number | undefined;

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

  private draw(): void {
    if (!this.window) return;
    const selected = this.selectedId === undefined ? undefined : this.core.getMeeting(this.selectedId);
    const html = renderMeetingsPage(this.core.listMeetings(), selected);
    void this.window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  }
}
