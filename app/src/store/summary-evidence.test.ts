import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { applyNames } from "../core/participants.js";
import { openStore } from "./store.js";
import { fixtureSummary, fixtureTranscript } from "../testing/fake-pipeline.js";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { Summary } from "../pipeline/pipeline.js";

function grounded(): Summary {
  return { ...fixtureSummary, evidence: { revision: transcriptRevision(fixtureTranscript), tldr: [0, 1],
    participants: [{ speaker: "You", said: [[0]] }, { speaker: "Speaker 1", said: [[1]] }] },
    generation: { model: "test", promptVersion: "test", calls: 1, elapsedMs: 10 } };
}

it("persists evidence atomically, preserves it after rejected replacement, and invalidates it with the Transcript", () => {
  const dir = mkdtempSync(join(tmpdir(), "summary-evidence-"));
  const path = join(dir, "meetings.db");
  let store = openStore(path);
  try {
    const id = store.createMeeting({ app: "Test", startedAt: "2026-01-01" });
    store.saveTranscript(id, fixtureTranscript);
    store.saveSummary(id, grounded());
    store.close(); store = openStore(path);
    expect(store.getMeeting(id)?.summary).toEqual(grounded());
    store.renameParticipant(id, "You", "Maker");
    expect(store.getMeeting(id)?.summary?.evidence).toEqual(grounded().evidence);
    expect(applyNames(store.getMeeting(id)!).summary?.evidence).toEqual(grounded().evidence);
    expect(applyNames(store.getMeeting(id)!).summary?.generation).toEqual(grounded().generation);
    const invalid = grounded(); invalid.evidence!.tldr = [999];
    expect(() => store.saveSummary(id, invalid)).toThrow("Invalid Summary evidence");
    expect(store.getMeeting(id)?.summary).toEqual(grounded());
    const wrongSpeaker = grounded(); wrongSpeaker.evidence!.participants[0]!.said = [[1]];
    expect(() => store.saveSummary(id, wrongSpeaker)).toThrow("Invalid Summary evidence");
    store.saveTranscript(id, { segments: [{ start: 0, end: 1, speaker: "You", text: "A replacement discussion" }] });
    expect(store.getMeeting(id)?.summary).toBeNull();
    expect(store.searchMeetings("walking")).toEqual([]);
    store.deleteMeeting(id);
    expect(store.getMeeting(id)).toBeUndefined();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("migrates a version 2 Meeting without requiring Summary regeneration", () => {
  const dir = mkdtempSync(join(tmpdir(), "summary-migration-"));
  const path = join(dir, "meetings.db");
  let store = openStore(path);
  const id = store.createMeeting({ app: "Legacy", startedAt: "2026-01-01" });
  store.saveTranscript(id, fixtureTranscript); store.saveSummary(id, fixtureSummary); store.close();
  // Remove only the additive AI tables to reproduce the version 2 schema, without changing legacy data.
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE summary_artifacts; DROP TABLE chat_requests; DROP TABLE passage_index; DROP TABLE passages; PRAGMA user_version=2");
  legacy.close();
  try {
    store = openStore(path);
    expect(store.getMeeting(id)?.summary).toEqual(fixtureSummary);
    expect(store.getMeeting(id)?.transcript).toEqual(fixtureTranscript);
    store.saveSummary(id, grounded());
    expect(store.getMeeting(id)?.summary?.evidence).toEqual(grounded().evidence);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
