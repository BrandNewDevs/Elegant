import type { UpdateState } from "../core/updater.js";
import type { MeetingsApi } from "../shared/meetings-api.js";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { MeetingsViewState } from "../shared/meetings-view-state.js";
import type { PromptChoice } from "../shared/prompt-choice.js";
import type { SetupAction } from "../shared/setup-actions.js";
import type { SetupViewState } from "../shared/setup-view-state.js";

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const meetings = {
  ready: () => ipcRenderer.send("meetings:ready"),
  onState: (callback: (state: MeetingsViewState) => void) => subscribe("meetings:state", callback),
  settings: (open: boolean) => ipcRenderer.send("meetings:settings", open),
  setShowInDock: (show: boolean) => ipcRenderer.send("meetings:show-in-dock", show),
  setCheckForUpdates: (check: boolean) => ipcRenderer.send("meetings:check-for-updates", check),
  onUpdate: (callback: (update: Exclude<UpdateState, { status: "idle" }>) => void) => subscribe("meetings:update", callback),
  restartForUpdate: () => ipcRenderer.invoke("meetings:restart-for-update"),
  openRelease: () => ipcRenderer.send("meetings:open-release"),
  stopRecording: () => ipcRenderer.send("meetings:stop-recording"),
  select: (id: number) => ipcRenderer.send("meetings:select", id),
  search: (query: string) => ipcRenderer.send("meetings:search", query),
  rename: (payload: { meetingId: number; label: string; name: string }) =>
    ipcRenderer.send("meetings:rename", payload),
  export: (id: number) => ipcRenderer.send("meetings:export", id),
  regenerate: (id: number) => ipcRenderer.invoke("meetings:regenerate", id),
  delete: (id: number) => ipcRenderer.invoke("meetings:delete", id),
  sendQuestion: payload => ipcRenderer.invoke("meetings:send-question", payload),
  cancelQuestion: payload => ipcRenderer.invoke("meetings:cancel-question", payload),
  clearChat: (meetingId: number) => ipcRenderer.invoke("meetings:clear-chat", meetingId),
  openReference: payload => ipcRenderer.invoke("meetings:open-reference", payload),
  cancelJob: payload => ipcRenderer.invoke("meetings:cancel-job", payload),
} satisfies MeetingsApi;

contextBridge.exposeInMainWorld("electron", {
  meetings,
  setup: {
    ready: () => ipcRenderer.send("setup:ready"),
    onState: (callback: (state: SetupViewState) => void) => subscribe("setup:state", callback),
    act: (action: SetupAction) => ipcRenderer.send("setup:act", action),
    setUserName: (name: string) => ipcRenderer.send("setup:set-user-name", name),
  },
  prompt: {
    ready: () => ipcRenderer.send("prompt:ready"),
    onState: (callback: (state: { app: string }) => void) => subscribe("prompt:state", callback),
    choose: (choice: PromptChoice) => ipcRenderer.send("prompt:choose", choice),
    resize: (height: number) => ipcRenderer.send("prompt:resize", height),
  },
});
