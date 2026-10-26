import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openStore } from "./store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "store-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("upgrades a version 1 database, keeping its Meetings", () => {
  const path = join(dir, "meetings.db");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE meetings (id INTEGER PRIMARY KEY, app TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
      state TEXT NOT NULL CHECK (state IN ('recording','processing','done','failed')), error TEXT);
    CREATE TABLE participants (id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      label TEXT NOT NULL, name TEXT, UNIQUE (meeting_id, label));
    CREATE TABLE segments (id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE summaries (meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
      tldr TEXT NOT NULL, participants_json TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meetings (app, started_at, state) VALUES ('zoom.us', '2026-10-01T09:00:00.000Z', 'done');
    PRAGMA user_version = 1;
  `);
  old.close();

  const store = openStore(path);
  expect(store.getMeeting(1)).toMatchObject({ app: "zoom.us", state: "done", audio: null });
  store.saveAudio(1, { micPath: "/a/mic.wav", systemPath: "/a/system.wav" });
  expect(store.getMeeting(1)!.audio).toEqual({ micPath: "/a/mic.wav", systemPath: "/a/system.wav" });
  store.close();
});

it("indexes the Meetings of a database from before search existed", () => {
  const path = join(dir, "meetings.db");
  const first = openStore(path);
  const id = first.createMeeting({ app: "zoom.us", startedAt: "2026-10-01T09:00:00.000Z" });
  first.saveTranscript(id, { segments: [{ start: 0, end: 1, speaker: "You", text: "remember the milk" }] });
  first.saveSummary(id, { tldr: "Buy dairy.", participants: [] });
  first.close();
  const old = new DatabaseSync(path);
  old.exec("DROP TABLE search_index");
  old.close();

  const store = openStore(path);
  expect(store.searchMeetings("milk").map((m) => m.id)).toEqual([id]);
  expect(store.searchMeetings("dairy").map((m) => m.id)).toEqual([id]);
  store.close();
});

it("deletes a Meeting with its Participants, Transcript and Summary, and no other", () => {
  const store = openStore(":memory:");
  const keep = store.createMeeting({ app: "Slack", startedAt: "2026-10-01T08:00:00.000Z" });
  const gone = store.createMeeting({ app: "zoom.us", startedAt: "2026-10-01T09:00:00.000Z" });
  for (const id of [keep, gone]) {
    store.saveTranscript(id, { segments: [{ start: 0, end: 1, speaker: "You", text: "hello" }] });
    store.saveSummary(id, { tldr: "Hello.", participants: [{ speaker: "You", said: ["hello"] }] });
  }

  store.deleteMeeting(gone);

  expect(store.getMeeting(gone)).toBeUndefined();
  expect(store.listMeetings().map((m) => m.id)).toEqual([keep]);
  expect(store.getMeeting(keep)).toMatchObject({ participants: [{ label: "You" }], summary: { tldr: "Hello." } });
  store.close();
});

it("remembers a setting, and overwrites it", () => {
  const path = join(dir, "meetings.db");
  const store = openStore(path);
  expect(store.getSetting("keepAudio")).toBeUndefined();
  store.setSetting("keepAudio", "true");
  store.setSetting("keepAudio", "false");
  store.close();

  const reopened = openStore(path);
  expect(reopened.getSetting("keepAudio")).toBe("false");
  reopened.close();
});
