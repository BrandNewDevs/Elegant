import { expect, it } from "vitest";
import type { Meeting } from "../store/store.js";
import { renameFromLink, renderMeetingsPage } from "./meetings-page.js";

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

it("offers a rename field for each Participant, showing their label and current name", () => {
  const html = renderMeetingsPage([], meeting);
  expect(html).toContain('action="rename:4"');
  expect(html).toContain('name="label" value="Speaker 1"');
  expect(html).toContain('value="Priya &lt;PM&gt;"');
});

it("reads a submitted rename form back from its link", () => {
  expect(renameFromLink("rename:4?label=Speaker+1&name=Priya+Rao")).toEqual({ meetingId: 4, label: "Speaker 1", name: "Priya Rao" });
  expect(renameFromLink("rename:4?label=Speaker%201&name=")).toEqual({ meetingId: 4, label: "Speaker 1", name: "" });
});

it("ignores links that are not renames", () => {
  expect(renameFromLink("meeting:4")).toBeUndefined();
  expect(renameFromLink("rename:4?label=Speaker+1")).toBeUndefined();
  expect(renameFromLink("https://example.com/rename:4?label=a&name=b")).toBeUndefined();
});
