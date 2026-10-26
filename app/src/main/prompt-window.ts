import { BrowserWindow, screen } from "electron";
import { NOT_NOW_URL, RECORD_URL, promptHtml } from "./prompt-html.js";
import { promptPosition } from "./prompt-position.js";

/** Shows the Prompt overlay at the bottom centre of the screen. Closing it without answering counts as Not now. */
export function showPrompt(app: string, handlers: { record(): void; notNow(): void }): { close(): void } {
  const { workArea } = screen.getPrimaryDisplay();
  // The height is a first guess; the window is resized to its content before it is shown.
  const size = { width: 560, height: 72 };
  const win = new BrowserWindow({
    ...size,
    ...promptPosition(workArea, size),
    frame: false,
    transparent: true,
    hasShadow: true,
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
  win.once("ready-to-show", () => {
    // Fit the window to the card, so a long app name can never push the buttons out of view.
    void win.webContents
      .executeJavaScript("document.querySelector('.card').getBoundingClientRect().height")
      .then((height: number) => {
        const fitted = { width: size.width, height: Math.ceil(height) };
        win.setBounds({ ...fitted, ...promptPosition(workArea, fitted) });
      })
      .catch(() => {})
      .finally(() => {
        if (!win.isDestroyed()) win.showInactive(); // don't steal focus from the call
      });
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml(app))}`);
  return { close: () => answer(() => {}) };
}
