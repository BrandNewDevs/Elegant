import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Meeting } from "../../store/store";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { nothingDone } from "@/lib/test-electron";
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
    meetings: {
      ready: vi.fn(),
      onState: vi.fn(() => () => {}),
      settings: vi.fn(),
      setShowInDock: vi.fn(),
      select: vi.fn(),
      search: vi.fn(),
      rename: vi.fn(),
      export: vi.fn(),
      regenerate: vi.fn(),
      delete: vi.fn(),
    },
    setup: {} as Window["electron"]["setup"],
    prompt: {} as Window["electron"]["prompt"],
  };
});

it("shows the query in the box, escaped, and says when nothing matches", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: false, meetings: [], selected: undefined, query: `"><script>` });
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
      showInDock: false,
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
    callback({ settingsOpen: false, showInDock: false, meetings: [], selected: meeting, query: "" });
    return () => {};
  });
  render(<MeetingsApp />);
  expect(screen.getByDisplayValue("Priya <PM>")).toBeTruthy();
  expect(screen.getByText("Speaker 1")).toBeTruthy();
});

it("opens Settings from the sidebar", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: false, showInDock: false, meetings: [], selected: undefined, query: "" });
    return () => {};
  });
  render(<MeetingsApp />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(true);
});

it("shows Settings as a dialog over the Meetings when it is open, and asks to close it", () => {
  window.electron.meetings.onState = vi.fn((callback: (state: MeetingsViewState) => void) => {
    callback({ settingsOpen: true, showInDock: true, meetings: [], selected: undefined, query: "" });
    return () => {};
  });
  window.electron.setup = {
    ready: vi.fn(),
    onState: (callback) => {
      callback(nothingDone);
      return () => {};
    },
    act: vi.fn(),
    setUserName: vi.fn(),
  };
  render(<MeetingsApp />);
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  expect(screen.getByPlaceholderText("Search meetings")).toBeTruthy();
  expect(screen.getByRole("switch", { name: "Show in Dock" }).getAttribute("aria-checked")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(window.electron.meetings.settings).toHaveBeenCalledWith(false);
});
