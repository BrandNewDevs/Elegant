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
