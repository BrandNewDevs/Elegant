import type { MeetingsApi } from "../../shared/meetings-api";
import { vi } from "vitest";
import type { SetupViewState } from "../../shared/setup-view-state";

export const nothingDone: SetupViewState = {
  name: "Elegant",
  userName: "",
  permissionsGranted: false,
  state: {
    microphone: { status: "todo" },
    systemAudio: { status: "todo" },
    models: { status: "todo", fraction: 0 },
    ollama: { status: "todo" },
  },
};

/** Gives the page a fake `window.electron` that pushes `view` as soon as the page subscribes; returns the `act` spy. */
export function pushSetupState(view: SetupViewState) {
  const act = vi.fn();
  const setUserName = vi.fn();
  const setShowInDock = vi.fn();
  const setCheckForUpdates = vi.fn();
  window.electron = {
    setup: {
      ready: vi.fn(),
      onState: (callback: (state: SetupViewState) => void) => {
        callback(view);
        return () => {};
      },
      act,
      setUserName,
    },
    meetings: createMeetingsApi({ setShowInDock, setCheckForUpdates }),
    prompt: {} as Window["electron"]["prompt"],
  };
  return Object.assign(act, { setUserName, setShowInDock, setCheckForUpdates });
}

export function withState(patch: Partial<SetupViewState["state"]>, permissionsGranted = false): SetupViewState {
  return { ...nothingDone, permissionsGranted, state: { ...nothingDone.state, ...patch } };
}


/** Typed spies for renderer tests; individual operations can be overridden without rebuilding the bridge. */
export function createMeetingsApi(overrides: Partial<MeetingsApi> = {}) {
  const api = {
    ready: vi.fn(),
    onState: vi.fn((_callback: Parameters<MeetingsApi["onState"]>[0]) => () => {}),
    settings: vi.fn(), setShowInDock: vi.fn(), setCheckForUpdates: vi.fn(), openRelease: vi.fn(),
    onUpdateAvailable: vi.fn((_callback: Parameters<MeetingsApi["onUpdateAvailable"]>[0]) => () => {}), select: vi.fn(), search: vi.fn(), rename: vi.fn(), export: vi.fn(),
    regenerate: vi.fn(async () => {}), delete: vi.fn(async () => {}),
    sendQuestion: vi.fn(async (_payload: Parameters<MeetingsApi["sendQuestion"]>[0]) => {}),
    cancelQuestion: vi.fn(async (_payload: Parameters<MeetingsApi["cancelQuestion"]>[0]) => {}),
    clearChat: vi.fn(async (_meetingId: number) => {}),
    openReference: vi.fn(async (_payload: Parameters<MeetingsApi["openReference"]>[0]) => [] as number[]),
    cancelJob: vi.fn(async (_payload: Parameters<MeetingsApi["cancelJob"]>[0]) => {}),
  } satisfies MeetingsApi;
  return Object.assign(api, overrides);
}
