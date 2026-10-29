import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Meeting } from "../../store/store";
import type { ChatRecord } from "../../shared/meeting-chat";
import type { MeetingsViewState } from "../../shared/meetings-view-state";
import { createMeetingsApi } from "@/lib/test-electron";
import { MeetingsApp } from "./App";

const meeting: Meeting = { id: 4, app: "Synthetic Meeting", startedAt: "2026-10-24T10:00:00.000Z", endedAt: null,
  state: "done", error: null, participants: [{ label: "Speaker 1", name: "Priya" }], audio: null,
  transcript: { segments: [{ start: 12, end: 15, speaker: "Priya", text: "I will test the export on Friday." }, { start: 22, end: 24, speaker: "You", text: "Agreed." }] },
  summary: { tldr: "Priya will test the export.", participants: [{ speaker: "Priya", said: ["Will test the export on Friday."] }],
    evidence: { revision: "revision-a", tldr: [0], participants: [{ speaker: "Speaker 1", said: [[0]] }] } },
};
const record: ChatRecord = { id: "question-1", meetingId: 4, revision: "revision-a", question: "Who will test export?", status: "completed", error: null,
  answer: { text: "Priya will test the export.", refs: [0], sufficient: true }, generation: null, createdAt: "2026-10-24T10:00:00.000Z" };
function setup(patch: Partial<MeetingsViewState> = {}) {
  let state: MeetingsViewState = { settingsOpen: false, showInDock: false, checkForUpdates: true, meetings: [meeting], selected: meeting, query: "", chat: { available: true, history: [], revision: "revision-a" }, ...patch };
  let notify: (value: MeetingsViewState) => void = () => {};
  const api = createMeetingsApi({ onState: callback => { notify = callback; callback(state); return () => {}; } });
  window.electron = { meetings: api, setup: {} as Window["electron"]["setup"], prompt: {} as Window["electron"]["prompt"] };
  render(<MeetingsApp />);
  return { api, update: (next: Partial<MeetingsViewState>) => act(() => { state = { ...state, ...next }; notify(state); }) };
}
function openChat() { fireEvent.click(screen.getByRole("tab", { name: "Chat" })); }
function question() { return screen.getByRole("textbox", { name: "Question about this Meeting" }) as HTMLTextAreaElement; }

it("sends a question and preserves a draft across tabs", async () => {
  const { api } = setup(); openChat();
  fireEvent.change(question(), { target: { value: "When is the export test?" } });
  fireEvent.click(screen.getByRole("tab", { name: "Summary" })); openChat();
  expect(question().value).toBe("When is the export test?");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(api.sendQuestion).toHaveBeenCalledWith({ meetingId: 4, requestId: expect.any(String), question: "When is the export test?" }));
  await waitFor(() => expect(question().value).toBe(""));
});

it("keeps over-limit pasted text intact, explains the limit and prevents sending", () => {
  const { api } = setup(); openChat(); const text = "x".repeat(2001);
  fireEvent.change(question(), { target: { value: text } });
  expect(question().value).toBe(text);
  expect(screen.getByText(/Questions must be 2,000 characters or fewer/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(question(), { key: "Enter" }); expect(api.sendQuestion).not.toHaveBeenCalled();
});

it("supports Enter to send and respects Shift+Enter and IME composition", async () => {
  const { api } = setup(); openChat(); fireEvent.change(question(), { target: { value: "What was decided?" } });
  fireEvent.keyDown(question(), { key: "Enter", shiftKey: true });
  fireEvent.keyDown(question(), { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(question(), { key: "Enter", isComposing: true });
  expect(api.sendQuestion).not.toHaveBeenCalled();
  fireEvent.keyDown(question(), { key: "Enter" });
  await waitFor(() => expect(api.sendQuestion).toHaveBeenCalledTimes(1));
});

it("shows send failure and retries with a fresh request ID", async () => {
  const { api } = setup(); api.sendQuestion.mockRejectedValueOnce(new Error("Ollama is offline")); openChat();
  fireEvent.change(question(), { target: { value: "Who will test?" } }); fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Ollama is offline"); fireEvent.click(screen.getByRole("button", { name: "Retry sending" }));
  await waitFor(() => expect(api.sendQuestion).toHaveBeenCalledTimes(2));
  expect(api.sendQuestion.mock.calls[0]![0].requestId).not.toBe(api.sendQuestion.mock.calls[1]![0].requestId);
});

it("restores history, cancels active answers, clears chat and retries interrupted questions", async () => {
  const { api, update } = setup({ chat: { available: true, revision: "revision-a", history: [{ ...record, status: "retrieving", answer: { text: "partial output", refs: [0], sufficient: true } }] } }); openChat();
  expect(screen.getByText("Finding evidence")).toBeTruthy(); expect(screen.queryByText("partial output")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel answer" })); expect(api.cancelQuestion).toHaveBeenCalledWith({ meetingId: 4, requestId: "question-1" });
  update({ chat: { available: true, revision: "revision-a", history: [{ ...record, status: "interrupted", answer: null, error: "The app stopped." }] } });
  expect(screen.getByText("Interrupted")).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Retry question" }));
  await waitFor(() => expect(api.sendQuestion).toHaveBeenCalledWith({ meetingId: 4, requestId: expect.any(String), question: record.question }));
  fireEvent.click(screen.getByRole("button", { name: "Clear chat" })); expect(api.clearChat).toHaveBeenCalledWith(4);
  update({ chat: { available: true, revision: "revision-a", history: [] } }); expect(screen.queryByText(record.question)).toBeNull();
});

it("opens Summary and chat evidence in the Transcript, focusing and highlighting original ordinals without audio", async () => {
  const { api } = setup({ chat: { available: true, revision: "revision-a", history: [record] } }); api.openReference.mockResolvedValue([0]);
  fireEvent.click(screen.getAllByRole("button", { name: "View Transcript at 0:12" })[0]!);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Transcript" }).getAttribute("aria-selected")).toBe("true"));
  const segment = screen.getByLabelText("Transcript at 0:12");
  expect(segment.getAttribute("data-highlighted")).toBe("true"); expect(document.activeElement).toBe(segment);
  expect(api.openReference).toHaveBeenCalledWith({ meetingId: 4, revision: "revision-a", refs: [0] });
  openChat(); fireEvent.click(screen.getByRole("button", { name: "View Transcript at 0:12" }));
  await waitFor(() => expect(api.openReference).toHaveBeenCalledTimes(2));
});

it("does not navigate when a reference resolves after selecting a different Meeting or Transcript revision", async () => {
  const { api, update } = setup(); let resolve!: (refs: number[]) => void;
  api.openReference.mockReturnValue(new Promise<number[]>(done => { resolve = done; }));
  fireEvent.click(screen.getAllByRole("button", { name: "View Transcript at 0:12" })[0]!);
  update({ selected: { ...meeting, id: 9, app: "Other Meeting" }, chat: { available: true, revision: "revision-b", history: [] } });
  await act(async () => resolve([0]));
  expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.queryByLabelText("Transcript at 0:12")).toBeNull();
  api.openReference.mockReturnValue(new Promise<number[]>(done => { resolve = done; }));
  fireEvent.click(screen.getAllByRole("button", { name: "View Transcript at 0:12" })[0]!);
  update({ chat: { available: true, revision: "revision-c", history: [] } });
  await act(async () => resolve([0]));
  expect(screen.getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
});

it("drops stale RPC errors and resets drafts when changing Meetings", async () => {
  const { api, update } = setup(); let reject!: (error: Error) => void;
  api.sendQuestion.mockReturnValue(new Promise<void>((_resolve, fail) => { reject = fail; })); openChat();
  fireEvent.change(question(), { target: { value: "Question for the first Meeting" } }); fireEvent.click(screen.getByRole("button", { name: "Send" }));
  update({ selected: { ...meeting, id: 9 }, chat: { available: true, revision: "revision-b", history: [] } });
  await act(async () => reject(new Error("Old Meeting failure"))); openChat();
  expect(question().value).toBe(""); expect(screen.queryByText("Old Meeting failure")).toBeNull();
});

it("renders generated and Participant content as plain text and keeps existing actions working", async () => {
  const hostile = '<script>alert("no")</script>';
  const { api } = setup({ chat: { available: true, revision: "revision-a", history: [{ ...record, answer: { text: hostile, refs: [0], sufficient: true } }] } });
  fireEvent.click(screen.getByRole("button", { name: "Participants" }));
  fireEvent.change(screen.getByLabelText("Speaker 1"), { target: { value: "Alex <PM>" } }); fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(api.rename).toHaveBeenCalledWith({ meetingId: 4, label: "Speaker 1", name: "Alex <PM>" });
  const openMenu = () => fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  openMenu(); fireEvent.click(screen.getByRole("menuitem", { name: "Regenerate Summary" })); expect(api.regenerate).toHaveBeenCalledWith(4);
  expect(screen.queryByRole("menu")).toBeNull(); // choosing an item closes the menu
  openMenu(); fireEvent.click(screen.getByRole("menuitem", { name: "Export to Markdown…" })); expect(api.export).toHaveBeenCalledWith(4);
  openMenu(); fireEvent.click(screen.getByRole("menuitem", { name: "Delete Meeting…" })); expect(api.delete).toHaveBeenCalledWith(4);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "export" } }); fireEvent.blur(screen.getByRole("searchbox")); expect(api.search).toHaveBeenCalledWith("export");
  openChat(); expect(screen.getByText(hostile)).toBeTruthy(); expect(document.querySelector("script")).toBeNull();
});

it("allows chat after Summary failure, disables it without a ready Transcript and explains legacy evidence", () => {
  const { update } = setup({ selected: { ...meeting, state: "failed", error: "Summary failed", summary: { tldr: "Legacy Summary", participants: [] } } });
  expect(screen.getByText(/This Summary has no Transcript references/)).toBeTruthy(); openChat(); expect(question().disabled).toBe(false);
  update({ chat: { available: false, revision: "revision-a", history: [] } }); expect(question().disabled).toBe(true);
  expect(screen.getByText(/Chat becomes available/)).toBeTruthy();
});

it("shows queued and running work as toasts, with cancellation for text generation and queued work only", async () => {
  const { api } = setup({ jobs: [
    { id: "native", owner: "meeting:4", kind: "transcription-and-summary", status: "running" },
    { id: "text", owner: "meeting:4", kind: "summary", status: "queued" },
  ] });
  expect(await screen.findByText("Transcribing Meeting")).toBeTruthy();
  expect(await screen.findByText("Writing Summary (queued)")).toBeTruthy();
  expect(screen.queryByLabelText("Local AI queue")).toBeNull(); // no loader panel on the page
  expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1); // the running transcription cannot be interrupted
  fireEvent.click(screen.getByRole("button", { name: "Cancel" })); expect(api.cancelJob).toHaveBeenCalledWith({ meetingId: 4, jobId: "text" });
});

it("turns a job's toast into its outcome once the Meeting settles", async () => {
  const running = { ...meeting, state: "processing" as const };
  const { update } = setup({ meetings: [running], selected: running, jobs: [{ id: "job-1", owner: "meeting:4", kind: "summary", status: "running" }] });
  expect(await screen.findByText("Writing Summary")).toBeTruthy();
  update({ jobs: [] }); // the queue lets go before the Meeting is marked done
  expect(screen.queryByText("Summary ready")).toBeNull();
  update({ meetings: [meeting], selected: meeting });
  expect(await screen.findByText("Summary ready")).toBeTruthy();
  expect(screen.queryByText("Writing Summary")).toBeNull();
});

it("reports a failed job in its toast", async () => {
  const running = { ...meeting, state: "processing" as const };
  const failed = { ...meeting, state: "failed" as const, error: "Ollama is offline" };
  const { update } = setup({ meetings: [running], selected: running, jobs: [{ id: "job-2", owner: "meeting:4", kind: "transcription-and-summary", status: "running" }] });
  await screen.findByText("Transcribing Meeting");
  update({ jobs: [], meetings: [failed], selected: failed });
  expect(await screen.findByText("Transcribing Meeting failed")).toBeTruthy();
});
