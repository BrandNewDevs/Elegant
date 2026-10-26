import { DatabaseSync } from "node:sqlite";
import type { Summary, Tracks, Transcript } from "../pipeline/pipeline.js";

export type MeetingState = "recording" | "processing" | "done" | "failed";

export interface MeetingListItem {
  id: number;
  app: string;
  startedAt: string;
  state: MeetingState;
}

export interface Participant {
  label: string;
  /** The name the user gave this Participant; null until renamed. */
  name: string | null;
}

export interface Meeting extends MeetingListItem {
  endedAt: string | null;
  error: string | null;
  participants: Participant[];
  transcript: Transcript;
  summary: Summary | null;
  /** The Recording's tracks while its audio is kept, so a failed transcription can be retried; null once deleted. */
  audio: Tracks | null;
}

export interface Store {
  createMeeting(input: { app: string; startedAt: string }): number;
  setMeetingState(id: number, state: MeetingState, error?: string): void;
  saveTranscript(id: number, transcript: Transcript): void;
  saveSummary(id: number, summary: Summary): void;
  saveAudio(id: number, tracks: Tracks): void;
  clearAudio(id: number): void;
  /** Removes the Meeting and everything stored for it: Participants, Transcript segments and Summary. */
  deleteMeeting(id: number): void;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  getMeeting(id: number): Meeting | undefined;
  /** Newest first. */
  listMeetings(): MeetingListItem[];
  close(): void;
}

const SCHEMA_VERSION = 2;

const SCHEMA = `
  CREATE TABLE meetings (
    id         INTEGER PRIMARY KEY,
    app        TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    state      TEXT NOT NULL CHECK (state IN ('recording','processing','done','failed')),
    error      TEXT,
    mic_path   TEXT,
    system_path TEXT
  );
  CREATE TABLE participants (
    id         INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    name       TEXT,
    UNIQUE (meeting_id, label)
  );
  CREATE TABLE segments (
    id         INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    start      REAL NOT NULL,
    end        REAL NOT NULL,
    speaker    TEXT NOT NULL,
    text       TEXT NOT NULL
  );
  CREATE TABLE summaries (
    meeting_id        INTEGER PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    tldr              TEXT NOT NULL,
    participants_json TEXT NOT NULL
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version === 0) {
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (version === 1) {
    db.exec("ALTER TABLE meetings ADD COLUMN mic_path TEXT");
    db.exec("ALTER TABLE meetings ADD COLUMN system_path TEXT");
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  const inTransaction = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  return {
    createMeeting({ app, startedAt }) {
      const r = db
        .prepare("INSERT INTO meetings (app, started_at, state) VALUES (?, ?, 'recording')")
        .run(app, startedAt);
      return Number(r.lastInsertRowid);
    },

    setMeetingState(id, state, error) {
      const ended = state === "processing" ? new Date().toISOString() : null;
      db.prepare(
        "UPDATE meetings SET state = ?, error = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?",
      ).run(state, error ?? null, ended, id);
    },

    saveTranscript(id, transcript) {
      inTransaction(() => {
        db.prepare("DELETE FROM segments WHERE meeting_id = ?").run(id);
        const insertSegment = db.prepare(
          "INSERT INTO segments (meeting_id, idx, start, end, speaker, text) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const insertParticipant = db.prepare(
          "INSERT OR IGNORE INTO participants (meeting_id, label) VALUES (?, ?)",
        );
        transcript.segments.forEach((s, i) => {
          insertParticipant.run(id, s.speaker);
          insertSegment.run(id, i, s.start, s.end, s.speaker, s.text);
        });
      });
    },

    saveSummary(id, summary) {
      db.prepare(
        "INSERT OR REPLACE INTO summaries (meeting_id, tldr, participants_json) VALUES (?, ?, ?)",
      ).run(id, summary.tldr, JSON.stringify(summary.participants));
    },

    saveAudio(id, tracks) {
      db.prepare("UPDATE meetings SET mic_path = ?, system_path = ? WHERE id = ?").run(tracks.micPath, tracks.systemPath, id);
    },

    clearAudio(id) {
      db.prepare("UPDATE meetings SET mic_path = NULL, system_path = NULL WHERE id = ?").run(id);
    },

    deleteMeeting(id) {
      db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
    },

    getSetting(key) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value;
    },

    setSetting(key, value) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    },

    getMeeting(id) {
      const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | undefined;
      if (!row) return undefined;
      const segments = db
        .prepare("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx")
        .all(id) as unknown as Transcript["segments"];
      const participants = db
        .prepare("SELECT label, name FROM participants WHERE meeting_id = ? ORDER BY id")
        .all(id) as unknown as Participant[];
      const s = db.prepare("SELECT tldr, participants_json FROM summaries WHERE meeting_id = ?").get(id) as
        | { tldr: string; participants_json: string }
        | undefined;
      return {
        id: row.id,
        app: row.app,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        state: row.state,
        error: row.error,
        participants,
        transcript: { segments },
        summary: s ? { tldr: s.tldr, participants: JSON.parse(s.participants_json) } : null,
        audio: row.mic_path && row.system_path ? { micPath: row.mic_path, systemPath: row.system_path } : null,
      };
    },

    listMeetings() {
      const rows = db
        .prepare("SELECT id, app, started_at, state FROM meetings ORDER BY started_at DESC, id DESC")
        .all() as unknown as Pick<MeetingRow, "id" | "app" | "started_at" | "state">[];
      return rows.map((r) => ({ id: r.id, app: r.app, startedAt: r.started_at, state: r.state }));
    },


    close() {
      db.close();
    },
  };
}

interface MeetingRow {
  id: number;
  app: string;
  started_at: string;
  ended_at: string | null;
  state: MeetingState;
  error: string | null;
  mic_path: string | null;
  system_path: string | null;
}
