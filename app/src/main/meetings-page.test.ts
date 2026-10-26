import { describe, expect, it } from "vitest";
import { meetingIdFromLink, renderMeetingsPage, searchFromLink } from "./meetings-page.js";

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
