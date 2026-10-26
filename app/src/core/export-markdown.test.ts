import { afterEach, describe, expect, it } from "vitest";
import { meetingToMarkdown } from "./export-markdown.js";
import { AppCore } from "./app-core.js";
import { USER_NAME_SETTING } from "./participants.js";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { Summary, Transcript } from "../pipeline/pipeline.js";
import { openStore, type Meeting, type Store } from "../store/store.js";
import { FakeEngine } from "../testing/fake-engine.js";
import { fakePipeline } from "../testing/fake-pipeline.js";

const transcript: Transcript = { segments: [
  { start: 12, end: 18, speaker: "You", text: "You told Speaker 1 that the guide needs a test." },
  { start: 65, end: 72, speaker: "Speaker 1", text: "I will review the guide." },
  { start: 110, end: 115, speaker: "You", text: "I will finish the test by Thursday." },
] };
function summary(): Summary {
  return { tldr: "You will test the guide; Speaker 1 will review it.", participants: [
    { speaker: "You", said: ["The guide needs a test.", "Will finish the test by Thursday."] },
    { speaker: "Speaker 1", said: ["Will review the guide."] },
  ], evidence: { revision: transcriptRevision(transcript), tldr: [1, 0, 1], participants: [
    { speaker: "You", said: [[0], [2, 0, 0]] }, { speaker: "Speaker 1", said: [[1]] },
  ] }, generation: { promptVersion: "synthetic-test", model: "local:test", elapsedMs: 1, calls: 1 } };
}
function meeting(): Meeting {
  return { id: 1, app: "Synthetic", startedAt: "2026-10-27T12:00:00Z", endedAt: null, state: "done", error: null,
    participants: [{ label: "You", name: null }, { label: "Speaker 1", name: null }],
    transcript: structuredClone(transcript), summary: summary(), audio: null };
}
const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));

describe("Summary evidence in Markdown exports", () => {
  it("adds chronological, deduplicated supporting timestamps to the TLDR and each point", () => {
    const markdown = meetingToMarkdown(meeting());
    expect(markdown).toContain("You will test the guide; Speaker 1 will review it. (source 0:12, 1:05)");
    expect(markdown).toContain("- The guide needs a test. (source 0:12)");
    expect(markdown).toContain("- Will finish the test by Thursday. (source 0:12, 1:50)");
    expect(markdown).toContain("- Will review the guide. (source 1:05)");
    expect(markdown).toContain("**You** (0:12): You told Speaker 1 that the guide needs a test.");
    expect(markdown).not.toContain("source 1:05, 0:12");
  });

  it("validates raw speaker identities before applying current global and per-Meeting names", () => {
    const original = meeting(); original.participants[1]!.name = "Rhea";
    const markdown = meetingToMarkdown(original, "Kenny");
    expect(markdown).toContain("Kenny will test the guide; Rhea will review it. (source 0:12, 1:05)");
    expect(markdown).toContain("### Kenny");
    expect(markdown).toContain("### Rhea");
    expect(markdown).toContain("**Kenny** (0:12): You told Speaker 1 that the guide needs a test.");
    expect(markdown).toContain("- Will review the guide. (source 1:05)");
    original.participants[0]!.name = "Tara";
    const override = meetingToMarkdown(original, "Kenny");
    expect(override).toContain("Tara will test the guide");
    expect(override).not.toContain("Kenny");
    expect(override).toContain("**Tara** (0:12): You told Speaker 1 that the guide needs a test.");
    expect(original.transcript).toEqual(transcript);
    expect(original.summary!.participants[0]!.speaker).toBe("You");
  });

  it("preserves legacy exports without inventing evidence or needing retained audio", () => {
    const original = meeting();
    delete original.summary!.evidence; delete original.summary!.generation;
    original.audio = { micPath: "/nonexistent/synthetic-mic.wav", systemPath: "/nonexistent/synthetic-system.wav" };
    expect(meetingToMarkdown(original)).toBe([
      "# Synthetic", "", "Recorded 2026-10-27T12:00:00Z", "", "## Summary", "",
      "You will test the guide; Speaker 1 will review it.", "", "### You", "",
      "- The guide needs a test.", "- Will finish the test by Thursday.", "", "### Speaker 1", "", "- Will review the guide.",
      "", "## Transcript", "", "**You** (0:12): You told Speaker 1 that the guide needs a test.", "",
      "**Speaker 1** (1:05): I will review the guide.", "", "**You** (1:50): I will finish the test by Thursday.", "",
    ].join("\n"));
    expect(meetingToMarkdown(original)).not.toContain("nonexistent");
  });

  it("does not print stale, unknown, mismatched or wrongly attributed evidence", () => {
    const stale = meeting(); stale.transcript.segments[0]!.text = "A replaced Transcript.";
    expect(meetingToMarkdown(stale)).not.toContain("(source");
    const mismatch = meeting(); mismatch.summary!.evidence!.participants[0]!.speaker = "Wrong speaker";
    expect(meetingToMarkdown(mismatch)).not.toContain("(source");
    const invalid = meeting(); invalid.summary!.evidence!.tldr = [99];
    invalid.summary!.evidence!.participants[0]!.said[0] = [1];
    const markdown = meetingToMarkdown(invalid);
    expect(markdown).toContain("You will test the guide; Speaker 1 will review it.\n");
    expect(markdown).toContain("- The guide needs a test.\n");
    expect(markdown).toContain("- Will review the guide. (source 1:05)");
  });

  it("keeps the previous Summary evidence in AppCore exports after regeneration fails and omits chat", async () => {
    const store = openStore(":memory:"); stores.push(store);
    const id = store.createMeeting({ app: "Synthetic", startedAt: "2026-10-27T12:00:00Z" });
    const previous = summary();
    previous.evidence!.tldr = [0, 1]; previous.evidence!.participants[0]!.said[1] = [0, 2];
    store.saveTranscript(id, transcript); store.saveSummary(id, previous); store.setMeetingState(id, "done");
    store.setSetting(USER_NAME_SETTING, "Kenny"); store.renameParticipant(id, "Speaker 1", "Rhea");
    store.createChatRequest({ id: "synthetic-chat", meetingId: id, revision: previous.evidence!.revision, question: "CHAT ONLY QUESTION", createdAt: "2026-10-27" });
    store.updateChatRequest("synthetic-chat", previous.evidence!.revision, { status: "completed", answer: { text: "CHAT ONLY ANSWER", refs: [], sufficient: false },
      generation: { promptVersion: "synthetic-test", model: "local:test", elapsedMs: 0, calls: 0, retrievalCalls: 0, retrievalMode: "full", exhaustive: true } });
    const pipeline = fakePipeline(); pipeline.summarise = async () => { throw new Error("Synthetic model failure"); };
    const core = new AppCore({ engine: new FakeEngine(), store, pipeline });
    const before = core.exportMeeting(id).markdown;
    await core.regenerateSummary(id); await core.idle();
    expect(core.getMeeting(id)!.state).toBe("failed");
    expect(core.exportMeeting(id).markdown).toBe(before);
    expect(before).toContain("Kenny will test the guide; Rhea will review it. (source 0:12, 1:05)");
    expect(before).not.toContain("CHAT ONLY");
  });
});
