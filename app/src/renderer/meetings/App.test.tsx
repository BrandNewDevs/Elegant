import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { UpdateState } from "../../core/updater";
import type { Meeting } from "../../store/store";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { createMeetingsApi, nothingDone } from "@/lib/test-electron";
import { MeetingsApp } from "./App";

const meeting: Meeting = {
  id: 4,
  app: "zoom.us",
  startedAt: "2026-10-24T10:00:00.000Z",
  endedAt: null,
  state: "done",
  error: null,
  participants: [
    { label: "You", name: null },
    { label: "Speaker 1", name: "Priya <PM>" },
  ],
  transcript: { segments: [{ start: 1, end: 2, speaker: "Priya <PM>", text: "Hello" }] },
  summary: null,
  audio: null,
};

beforeEach(() => {
  window.electron = {
    meetings: createMeetingsApi(),
    setup: {} as Window["electron"]["setup"],
    prompt: {} as Window["electron"]["prompt"],
  };
});

it("shows the query in the box, escaped, and says when nothing matches", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: false, checkForUpdates: true, meetings: [], selected: undefined, query: `"><script>` });
    return () => {};
  });
  render(<MeetingsApp />);
  const input = screen.getByPlaceholderText("Search meetings") as HTMLInputElement;
  expect(input.value).toBe(`"><script>`);
  expect(screen.getByText("No Meetings match.")).toBeTruthy();
});

it("lists Meetings and selects one", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({
      settingsOpen: false,
      showInDock: false, checkForUpdates: true,
      meetings: [{ id: 7, app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z", state: "done" }],
      selected: undefined,
      query: "x",
    });
    return () => {};
  });
  render(<MeetingsApp />);
  expect(screen.getByText("zoom.us")).toBeTruthy();
});

it("offers a rename field for each Participant, showing their label and current name", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: false, checkForUpdates: true, meetings: [], selected: meeting, query: "" });
    return () => {};
  });
  render(<MeetingsApp />);
  fireEvent.click(screen.getByRole("button", { name: "Participants" }));
  expect(screen.getByDisplayValue("Priya <PM>")).toBeTruthy();
  expect(screen.getByText("Speaker 1")).toBeTruthy();
});

it("opens Settings from the sidebar", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: false, checkForUpdates: true, meetings: [], selected: undefined, query: "" });
    return () => {};
  });
  render(<MeetingsApp />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(true);
});

function showState(patch: Partial<MeetingsViewState>) {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: true, checkForUpdates: true, meetings: [], selected: undefined, query: "", ...patch });
    return () => {};
  });
}

function showSetup(view = nothingDone) {
  window.electron.setup = { ready: vi.fn(), onState: (callback) => { callback(view); return () => {}; }, act: vi.fn(), setUserName: vi.fn(), configureAI: vi.fn(async () => "Saved") };
}

it("shows Settings as a page in the main area when it is open, and asks to close it from Back", () => {
  showState({ settingsOpen: true, appVersion: "0.1.3" });
  showSetup();
  render(<MeetingsApp />);
  expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByPlaceholderText("Search meetings")).toBeTruthy(); // the sidebar stays
  expect(screen.getByRole("switch", { name: "Show in Dock" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByLabelText("Name")).toBeTruthy(); // the name lives in General now

  fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(false);
});

it("picks the Meeting and leaves Settings when one is chosen in the sidebar", () => {
  showState({ settingsOpen: true, meetings: [meeting], selected: meeting });
  showSetup();
  render(<MeetingsApp />);
  fireEvent.click(screen.getByRole("button", { name: /zoom\.us/ }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(false);
  expect(window.electron.meetings.select).toHaveBeenCalledWith(4);
});

it("has no Profile entry: the name is in Settings", () => {
  showState({ meetings: [meeting], selected: meeting });
  render(<MeetingsApp />);
  expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
});

it("groups the Meetings by day and does not split search results", () => {
  const now = new Date();
  const earlier = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 15, 0).toISOString();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0).toISOString();
  const list = [{ id: 2, app: "Slack", startedAt: today, state: "done" as const }, { id: 1, app: "Zoom", startedAt: earlier, state: "failed" as const }];
  showState({ meetings: list });
  const { unmount } = render(<MeetingsApp />);
  expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Yesterday" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Zoom.*Failed/ })).toBeTruthy();
  unmount();

  showState({ meetings: list, query: "o" });
  render(<MeetingsApp />);
  expect(screen.queryByRole("heading", { name: "Today" })).toBeNull();
  expect(screen.getAllByRole("button", { name: /Slack|Zoom/ })).toHaveLength(2);
});

it("shows the Recording in progress at the foot of the sidebar, with a Stop button", () => {
  showState({ recording: { app: "zoom.us", startedAt: new Date(Date.now() - 65_000).toISOString() } });
  render(<MeetingsApp />);
  expect(screen.getByText(/Recording zoom\.us · 1:0\d/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(window.electron.meetings.stopRecording).toHaveBeenCalledTimes(1);
});

it("shows a ready update in the sidebar until it is installed: Restart restarts, the text opens its Settings section", () => {
  showState({ update: { status: "ready", version: "0.1.4" } });
  render(<MeetingsApp />);
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(window.electron.meetings.restartForUpdate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Version 0.1.4 is ready" }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(true);
});

it("shows an update that is downloading or failed, and links a failed one to its release page", () => {
  showState({ update: { status: "downloading", version: "0.1.4", percent: 30 } });
  const { unmount } = render(<MeetingsApp />);
  expect(screen.getByText("Downloading 0.1.4… 30%")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  unmount();

  showState({ update: { status: "failed", version: "0.1.4", url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.1.4", message: "no" } });
  render(<MeetingsApp />);
  fireEvent.click(screen.getByRole("button", { name: "View release" }));
  expect(window.electron.meetings.openRelease).toHaveBeenCalledTimes(1);
});

it("shows nothing about updates or Recordings when there are none", () => {
  showState({});
  render(<MeetingsApp />);
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
});

type UpdateNews = Exclude<UpdateState, { status: "idle" }>;

function subscribeToUpdates() {
  let announce: (update: UpdateNews) => void = () => {};
  window.electron.meetings.onUpdate = vi.fn((callback: (update: UpdateNews) => void) => {
    announce = callback;
    return () => {};
  });
  return (update: UpdateNews) => act(() => announce(update));
}

it("shows an update downloading, then ready with a Restart button that asks the app to restart", async () => {
  const announce = subscribeToUpdates();
  window.electron.meetings.restartForUpdate = vi.fn(async () => ({ ok: true as const }));
  render(<MeetingsApp />);

  announce({ status: "downloading", version: "0.2.0", percent: 42 });
  expect(await screen.findByText("Downloading version 0.2.0… 42%")).toBeTruthy();

  announce({ status: "ready", version: "0.2.0" });
  expect(await screen.findByText("Version 0.2.0 is ready. Restart to update")).toBeTruthy();
  expect(screen.queryByText(/Downloading version/)).toBeNull(); // one toast, replaced in place
  expect(window.electron.meetings.restartForUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(window.electron.meetings.restartForUpdate).toHaveBeenCalledTimes(1);
});

it("says why when the app refuses to restart, and keeps the Restart button for later", async () => {
  const announce = subscribeToUpdates();
  window.electron.meetings.restartForUpdate = vi.fn(async () => ({ ok: false as const, reason: "A Recording is in progress. Stop it first, then restart to update." }));
  render(<MeetingsApp />);

  announce({ status: "ready", version: "0.2.0" });
  fireEvent.click(await screen.findByRole("button", { name: "Restart" }));
  expect(await screen.findByText("A Recording is in progress. Stop it first, then restart to update.")).toBeTruthy();
  expect(screen.getByText("Version 0.2.0 is ready. Restart to update")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart" }));
  expect(window.electron.meetings.restartForUpdate).toHaveBeenCalledTimes(2);
});

it("toasts a failed update with a View release button that asks to open its page", async () => {
  const announce = subscribeToUpdates();
  render(<MeetingsApp />);

  announce({ status: "failed", version: "0.2.0", url: "https://github.com/BrandNewDevs/Elegant/releases/tag/v0.2.0", message: "no" });
  expect(await screen.findByText("Could not update to version 0.2.0")).toBeTruthy();
  expect(window.electron.meetings.openRelease).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View release" }));
  expect(window.electron.meetings.openRelease).toHaveBeenCalledTimes(1);
});
