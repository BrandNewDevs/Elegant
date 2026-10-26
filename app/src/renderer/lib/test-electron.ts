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
    meetings: {} as Window["electron"]["meetings"],
    prompt: {} as Window["electron"]["prompt"],
  };
  return Object.assign(act, { setUserName });
}

export function withState(patch: Partial<SetupViewState["state"]>, permissionsGranted = false): SetupViewState {
  return { ...nothingDone, permissionsGranted, state: { ...nothingDone.state, ...patch } };
}
