import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transcriptRevision } from "../pipeline/evidence.js";
import type { Transcript } from "../pipeline/pipeline.js";
import { openStore, type Store } from "./store.js";

let dir: string;
const opened: Store[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "passage-index-")); });
afterEach(() => { for (const store of opened.splice(0)) store.close(); rmSync(dir, { recursive: true, force: true }); });
function storeAt(path = ":memory:") { const store = openStore(path); opened.push(store); return store; }
function close(store: Store) { opened.splice(opened.indexOf(store), 1); store.close(); }
function meeting(store: Store, text: string) {
  const id = store.createMeeting({ app: "Synthetic discussion", startedAt: "2026-10-01T09:00:00.000Z" });
  const transcript = { segments: [{ start: 0, end: 10, speaker: "You", text }] };
  store.saveTranscript(id, transcript);
  return { id, transcript, revision: transcriptRevision(transcript) };
}

describe("Meeting passage retrieval through the Store", () => {
  it("preserves oversized Unicode text and stable fragments without truncation", () => {
    const store = storeAt();
    const text = "Read this café discussion 🙂 carefully.\n".repeat(180) + "界".repeat(1200) + " final word";
    const { id, revision } = meeting(store, text);
    const passages = store.listPassages(id, revision), sources = passages.flatMap(p => p.sources);
    expect(passages.length).toBeGreaterThan(5);
    expect(sources.map(source => source.text).join("")).toBe(text);
    expect(new Set(sources.map(source => source.id)).size).toBe(sources.length);
    expect(passages.map(p => p.index)).toEqual(passages.map((_, index) => index));
    sources.forEach((source, part) => {
      expect(source).toMatchObject({ id: `0:${part}`, ref: 0, part, speaker: "You", start: 0, end: 10 });
      expect(Buffer.byteLength(source.text, "utf8")).toBeLessThanOrEqual(1000);
      expect(source.text).not.toContain("\uFFFD");
    });
    expect(passages.every(p => p.text.length <= 1500)).toBe(true);
  });

  it("scopes ranked lookup to one Meeting and Transcript revision", () => {
    const store = storeAt(), a = meeting(store, "The amber launch is Friday."), b = meeting(store, "The amber launch is Monday.");
    expect(store.searchPassages(a.id, a.revision, "amber").map(p => p.meetingId)).toEqual([a.id]);
    expect(store.searchPassages(b.id, b.revision, "amber").map(p => p.meetingId)).toEqual([b.id]);
    expect(store.searchPassages(a.id, "older-revision", "amber")).toEqual([]);
    expect(store.listPassages(a.id, "older-revision")).toEqual([]);
    expect(store.searchPassages(9999, a.revision, "amber")).toEqual([]);
  });

  it("sanitizes FTS syntax, matches OR words and stems English words", () => {
    const store = storeAt(), a = meeting(store, "The permission reviewer is testing launches.");
    expect(store.searchPassages(a.id, a.revision, '"launch" OR (missing:term) NOT -none*')).toHaveLength(1);
    expect(store.searchPassages(a.id, a.revision, "launch unmatchedword")).toHaveLength(1);
    expect(store.searchPassages(a.id, a.revision, '"()---*')).toEqual([]);
    for (const limit of [0, 101]) expect(() => store.searchPassages(a.id, a.revision, "launch", limit)).toThrow(/limit/);
  });

  it("retrieves facts on both sides of a passage boundary and preserves their source order", () => {
    const store = storeAt(), a = meeting(store, "placeholder");
    const transcript: Transcript = { segments: [
      { start: 0, end: 10, speaker: "You", text: "context ".repeat(110) + " The old launch is Monday." },
      { start: 10, end: 20, speaker: "Speaker 1", text: "explanation ".repeat(70) + " Correction: the launch is Friday, replacing Monday." },
      { start: 20, end: 30, speaker: "You", text: "Agreed; Friday is final." },
    ] };
    store.saveTranscript(a.id, transcript);
    const revision = transcriptRevision(transcript), passages = store.listPassages(a.id, revision);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages.flatMap(p => p.sources).map(s => s.ref)).toEqual([0, 1, 2]);
    const hits = store.searchPassages(a.id, revision, "Monday Friday");
    expect(hits.map(p => p.text).join("\n")).toContain("Correction");
    expect(new Set(hits.flatMap(p => p.sources.map(s => s.ref)))).toEqual(new Set([0, 1, 2]));
    expect(store.searchPassages(a.id, revision, "Monday Friday", 1)).toHaveLength(1);
  });

  it("replaces passage data and index together when the Transcript changes", () => {
    const store = storeAt(), a = meeting(store, "The obsolete watermelon plan launches Monday.");
    const updated = { segments: [{ start: 1, end: 10, speaker: "You", text: "The current apricot plan launches Friday." }] };
    store.saveTranscript(a.id, updated);
    const revision = transcriptRevision(updated);
    expect(store.listPassages(a.id, a.revision)).toEqual([]);
    expect(store.searchPassages(a.id, revision, "watermelon")).toEqual([]);
    expect(store.searchPassages(a.id, revision, "apricot")).toHaveLength(1);
    expect(store.searchPassages(a.id, a.revision, "apricot")).toEqual([]);
    store.saveTranscript(a.id, { segments: [] });
    expect(store.listPassages(a.id, transcriptRevision({ segments: [] }))).toEqual([]);
    expect(store.searchPassages(a.id, revision, "apricot")).toEqual([]);
  });

  it("persists passages across restart, Participant renaming and Summary regeneration", () => {
    const path = join(dir, "meetings.db"), first = storeAt(path), a = meeting(first, "You will review the permission guide.");
    const before = first.listPassages(a.id, a.revision);
    first.renameParticipant(a.id, "You", "Alex");
    first.saveSummary(a.id, { tldr: "Guide review.", participants: [] });
    expect(first.listPassages(a.id, a.revision)).toEqual(before);
    close(first);
    const reopened = storeAt(path);
    expect(reopened.listPassages(a.id, a.revision)).toEqual(before);
    expect(reopened.searchPassages(a.id, a.revision, "permission")).toHaveLength(1);
  });

  it("backfills schema 3 Transcripts and repairs missing derived index rows", () => {
    const path = join(dir, "meetings.db"), first = storeAt(path), a = meeting(first, "Backfill the migration checklist.");
    close(first);
    const existing = new DatabaseSync(path);
    existing.exec("DELETE FROM passage_index; DELETE FROM passages");
    expect(existing.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
    existing.close();
    const rebuilt = storeAt(path);
    expect(rebuilt.listPassages(a.id, a.revision)).toHaveLength(1);
    expect(rebuilt.searchPassages(a.id, a.revision, "migration")).toHaveLength(1);
    close(rebuilt);
    const broken = new DatabaseSync(path); broken.exec("DELETE FROM passage_index"); broken.close();
    expect(storeAt(path).searchPassages(a.id, a.revision, "migration")).toHaveLength(1);
  });

  it("backfills a version 2 upgrade and removes all evidence when deleting its Meeting", () => {
    const path = join(dir, "meetings.db"), first = storeAt(path);
    const a = meeting(first, "The disappearing mango decision."), b = meeting(first, "The retained mango decision.");
    close(first);
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE passage_index; DROP TABLE passages; DROP TABLE chat_requests; DROP TABLE summary_artifacts; PRAGMA user_version=2");
    old.close();
    const upgraded = storeAt(path);
    expect(upgraded.searchPassages(a.id, a.revision, "mango")).toHaveLength(1);
    upgraded.deleteMeeting(a.id);
    expect(upgraded.listPassages(a.id, a.revision)).toEqual([]);
    expect(upgraded.searchPassages(a.id, a.revision, "mango")).toEqual([]);
    expect(upgraded.searchPassages(b.id, b.revision, "mango")).toHaveLength(1);
    close(upgraded);
    expect(storeAt(path).searchPassages(a.id, a.revision, "mango")).toEqual([]);
  });
});
