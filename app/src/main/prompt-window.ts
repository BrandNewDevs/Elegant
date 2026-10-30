import { BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import type { PromptChoice } from "../shared/prompt-choice.js";
import { promptPosition } from "./prompt-position.js";
import { preloadPath, rendererPagePath } from "./window-ui.js";

/**
 * Shows the Prompt overlay at the bottom centre of the screen. It has no timeout and is never dismissed by a click
 * elsewhere or by switching apps: it goes when the person answers, or when the caller closes it because the Meeting
 * ended. It is shown without taking focus, and nothing here takes focus again. Closing the window without answering
 * counts as the person closing the Prompt.
 */
export function showPrompt(app: string, handlers: { record(): void; close(): void; never(): void }): { close(): void } {
  const { workArea } = screen.getPrimaryDisplay();
  const size = { width: 640, height: 72 };
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
    // Without this the first click on an inactive window only activates it, and the buttons would need two.
    acceptFirstMouse: true,
    show: false,
    webPreferences: { preload: preloadPath(), sandbox: true, contextIsolation: true, nodeIntegration: false },
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

  const fromThis = (sender: WebContents) => !win.isDestroyed() && sender === win.webContents;

  const onReady = (event: Electron.IpcMainEvent) => {
    if (!fromThis(event.sender)) return;
    event.sender.send("prompt:state", { app });
  };
  const onChoose = (event: Electron.IpcMainEvent, choice: PromptChoice) => {
    if (!fromThis(event.sender)) return;
    if (choice === "record") answer(handlers.record);
    else if (choice === "never") answer(handlers.never);
    else answer(handlers.close);
  };
  const onResize = (event: Electron.IpcMainEvent, height: number) => {
    if (!fromThis(event.sender)) return;
    const fitted = { width: size.width, height: Math.max(72, Math.ceil(height)) };
    win.setBounds({ ...fitted, ...promptPosition(workArea, fitted) });
  };

  ipcMain.on("prompt:ready", onReady);
  ipcMain.on("prompt:choose", onChoose);
  ipcMain.on("prompt:resize", onResize);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    ipcMain.removeListener("prompt:ready", onReady);
    ipcMain.removeListener("prompt:choose", onChoose);
    ipcMain.removeListener("prompt:resize", onResize);
    answer(handlers.close);
  });

  void win.loadFile(rendererPagePath("prompt"));
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });

  return { close: () => answer(() => {}) };
}
