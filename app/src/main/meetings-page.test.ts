import { describe, expect, it } from "vitest";
import { meetingIdFromLink, renderMeetingsPage, searchFromLink, renameFromLink } from "./meetings-page.js";

describe("the Meetings page search", () => {
  it("reads the query from the link the search box submits to", () => {
    expect(searchFromLink("search:?q=launch+date")).toBe("launch date");
    expect(searchFromLink("search:?q=caf%C3%A9")).toBe("café");
    expect(searchFromLink("search:?q=")).toBe("");
    expect(searchFromLink("meeting:3")).toBeUndefined();
  });

  it("shows the query in the box, escaped, and says when nothing matches", () => {
    const html = renderMeetingsPage([], undefined, `"><script>`);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("No Meetings match.");
  });

  it("links each result to its Meeting", () => {
    const html = renderMeetingsPage([{ id: 7, app: "zoom.us", startedAt: "2026-10-24T10:00:00.000Z", state: "done" }], undefined, "x");
    const href = /href="([^"]+)"/.exec(html)![1]!;
    expect(meetingIdFromLink(href)).toBe(7);
  });
});

import type { Meeting } from "../store/store.js";

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
