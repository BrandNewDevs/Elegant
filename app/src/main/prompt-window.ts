import { BrowserWindow, screen } from "electron";
import { DISPLAY_NAME } from "../config.js";
import { promptPosition } from "./prompt-position.js";

const RECORD_URL = "prompt://record";
const NOT_NOW_URL = "prompt://not-now";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The buttons are links; the main process catches the navigation, so the page needs no preload or Node access. */
export function promptHtml(app: string): string {
  return `<!doctype html><meta charset="utf-8"><style>
    body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; padding: 14px; color: #1d1d1f;
           background: rgba(246, 246, 246, 0.96); height: 100vh; box-sizing: border-box; -webkit-user-select: none; }
    h1 { font-size: 13px; margin: 0 0 4px; } p { margin: 0 0 12px; color: #555; }
    a { display: inline-block; padding: 5px 14px; border-radius: 6px; margin-right: 8px; text-decoration: none;
        color: #1d1d1f; background: #e3e3e6; }
    a.record { color: white; background: #d92d20; }
    @media (prefers-color-scheme: dark) { body { background: rgba(40, 40, 42, 0.96); color: #f5f5f7; }
      p { color: #aaa; } a { color: #f5f5f7; background: #555; } a.record { background: #d92d20; } }
  </style>
  <h1>${escapeHtml(app)} is using your microphone</h1>
  <p>Record this Meeting? ${escapeHtml(DISPLAY_NAME)} keeps nothing unless you say so.</p>
  <a class="record" href="${RECORD_URL}">Record</a><a href="${NOT_NOW_URL}">Not now</a>`;
}

/** Shows the Prompt overlay at the bottom centre of the screen. Closing it without answering counts as Not now. */
export function showPrompt(app: string, handlers: { record(): void; notNow(): void }): { close(): void } {
  const { workArea } = screen.getPrimaryDisplay();
  const size = { width: 340, height: 96 };
  const win = new BrowserWindow({
    ...size,
    ...promptPosition(workArea, size),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true);

  let answered = false;
  const answer = (choose: () => void) => {
    if (answered) return;
    answered = true;
    choose();
    if (!win.isDestroyed()) win.close();
  };

  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (url === RECORD_URL) answer(handlers.record);
    else if (url === NOT_NOW_URL) answer(handlers.notNow);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => answer(handlers.notNow));
  win.once("ready-to-show", () => win.showInactive()); // don't steal focus from the call

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml(app))}`);
  return { close: () => answer(() => {}) };
}
