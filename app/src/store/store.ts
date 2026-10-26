import type { ChatAnswer, ChatGeneration, ChatRecord, ChatStatus } from "../shared/meeting-chat.js";
import { buildPassages, type EvidencePassage } from "../pipeline/passages.js";
import { transcriptRevision } from "../pipeline/evidence.js";
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
  /** Sets the name shown for a Participant in this Meeting; null clears it. Throws if the Meeting has no such label. */
  renameParticipant(id: number, label: string, name: string | null): void;
  saveAudio(id: number, tracks: Tracks): void;
  clearAudio(id: number): void;
  /** Removes the Meeting and everything stored for it: Participants, Transcript segments and Summary. */
  deleteMeeting(id: number): void;
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  getMeeting(id: number): Meeting | undefined;
  /** Newest first. */
  listMeetings(): MeetingListItem[];
  /**
   * The Meetings whose Transcript or Summary contains every word of the query (the last one as a prefix, so a
   * search works while it is being typed), newest first. A query with no words matches nothing.
   */
  searchMeetings(query: string): MeetingListItem[];
  /** Derived source passages in Transcript order, restricted to this Meeting and revision. */
  listPassages(meetingId: number, revision: string): EvidencePassage[];
  /** Ranked OR-word lookup; never returns evidence from a different Meeting or revision. */
  searchPassages(meetingId: number, revision: string, query: string, limit?: number): EvidencePassage[];
  createChatRequest(input: { id: string; meetingId: number; revision: string; question: string; createdAt: string }): ChatRecord;
  /** Full visible history, ordered by insertion rather than UUID or timestamp. */
  getChatHistory(meetingId: number): ChatRecord[];
  /** Changes only an existing active request. Terminal, cleared and stale requests cannot be resurrected. */
  updateChatRequest(id: string, revision: string, patch: { status: ChatStatus; answer?: ChatAnswer; error?: string; generation?: ChatGeneration }): boolean;
  clearChat(meetingId: number): void;
  /** Explicit startup recovery; opening the Store alone does not interrupt work. */
  interruptChats(): void;
  close(): void;
}

const SCHEMA_VERSION = 3;

const AI_SCHEMA = `
  CREATE TABLE summary_artifacts (
    meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
    revision TEXT NOT NULL, evidence_json TEXT NOT NULL, generation_json TEXT NOT NULL
  );
  CREATE TABLE chat_requests (
    id TEXT PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    revision TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL
      CHECK(status IN ('queued','retrieving','generating','completed','failed','cancelled','interrupted')),
    answer_json TEXT, error TEXT, generation_json TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE passages (
    id INTEGER PRIMARY KEY, meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    revision TEXT NOT NULL, idx INTEGER NOT NULL, refs_json TEXT NOT NULL, text TEXT NOT NULL,
    UNIQUE(meeting_id, revision, idx)
  );
  CREATE VIRTUAL TABLE passage_index USING fts5(
    passage_id UNINDEXED, meeting_id UNINDEXED, revision UNINDEXED, text, tokenize = 'porter unicode61'
  );
`;

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

/**
 * One row per Meeting, holding the text of its Transcript and of its Summary. It is not tied to the Meeting by a
 * foreign key, so every write and delete below keeps it in step by hand.
 */
const SEARCH_INDEX = `
  CREATE VIRTUAL TABLE search_index USING fts5(
    meeting_id UNINDEXED, transcript, summary, tokenize = 'porter unicode61'
  );
`;

/** An FTS5 query for the words in what the user typed, or undefined if there are none. */
function searchExpression(query: string): string | undefined {
  const words = query.match(/[\p{L}\p{N}]+/gu);
  if (!words) return undefined;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");

  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error("This database was created by a newer app version");
  }
  if (version < SCHEMA_VERSION) {
    db.exec("BEGIN");
    try {
      if (version === 0) db.exec(SCHEMA);
      else if (version === 1) {
        db.exec("ALTER TABLE meetings ADD COLUMN mic_path TEXT");
        db.exec("ALTER TABLE meetings ADD COLUMN system_path TEXT");
      }
      db.exec(AI_SCHEMA);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  // Created apart from the versions above, so it also appears in a database that predates it.
  const hasSearchIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_index'").get() !== undefined;
  if (!hasSearchIndex) db.exec(SEARCH_INDEX);

  const reindex = (id: number): void => {
    const transcript = (db.prepare("SELECT text FROM segments WHERE meeting_id = ? ORDER BY idx").all(id) as { text: string }[])
      .map((s) => s.text)
      .join("\n");
    const row = db.prepare("SELECT tldr, participants_json FROM summaries WHERE meeting_id = ?").get(id) as
      | { tldr: string; participants_json: string }
      | undefined;
    const summary = row
      ? [row.tldr, ...(JSON.parse(row.participants_json) as Summary["participants"]).flatMap((p) => p.said)].join("\n")
      : "";
    db.prepare("DELETE FROM search_index WHERE meeting_id = ?").run(id);
    db.prepare("INSERT INTO search_index (meeting_id, transcript, summary) VALUES (?, ?, ?)").run(id, transcript, summary);
  };
  if (!hasSearchIndex) {
    for (const { id } of db.prepare("SELECT id FROM meetings").all() as { id: number }[]) reindex(id);
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

  const rebuildPassages = (meetingId: number, transcript: Transcript): void => {
    db.prepare("DELETE FROM passage_index WHERE meeting_id = ?").run(meetingId);
    db.prepare("DELETE FROM passages WHERE meeting_id = ?").run(meetingId);
    const revision = transcriptRevision(transcript);
    const insert = db.prepare("INSERT INTO passages (meeting_id, revision, idx, refs_json, text) VALUES (?, ?, ?, ?, ?)");
    const index = db.prepare("INSERT INTO passage_index (passage_id, meeting_id, revision, text) VALUES (?, ?, ?, ?)");
    for (const passage of buildPassages(transcript)) {
      const id = insert.run(meetingId, revision, passage.index, JSON.stringify(passage.sources), passage.text).lastInsertRowid;
      index.run(id, meetingId, revision, passage.text);
    }
  };
  // Schema 3 originally reserved these tables. Build missing derived data without another migration.
  for (const { meeting_id } of db.prepare("SELECT DISTINCT meeting_id FROM segments").all() as { meeting_id: number }[]) {
    const segments = db.prepare("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx")
      .all(meeting_id) as unknown as Transcript["segments"];
    const revision = transcriptRevision({ segments });
    const count = (db.prepare("SELECT count(*) AS n FROM passages WHERE meeting_id = ? AND revision = ?").get(meeting_id, revision) as { n: number }).n;
    const indexed = (db.prepare("SELECT count(*) AS n FROM passage_index WHERE meeting_id = ? AND revision = ?").get(meeting_id, revision) as { n: number }).n;
    if (!count || count !== indexed) inTransaction(() => rebuildPassages(meeting_id, { segments }));
  }
  const passageRows = (rows: unknown[]): EvidencePassage[] => (rows as PassageRow[]).map(row => ({
    id: row.id, meetingId: row.meeting_id, revision: row.revision, index: row.idx,
    sources: JSON.parse(row.refs_json) as EvidencePassage["sources"], text: row.text,
  }));

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
        // A replacement Transcript invalidates every generated or derived fact about the old revision.
        db.prepare("DELETE FROM summary_artifacts WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM summaries WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM chat_requests WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM passage_index WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM passages WHERE meeting_id = ?").run(id);
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
        db.prepare("DELETE FROM participants WHERE meeting_id = ? AND label NOT IN (SELECT speaker FROM segments WHERE meeting_id = ?)").run(id, id);
        rebuildPassages(id, transcript);
        reindex(id);
      });
    },

    saveSummary(id, summary) {
      inTransaction(() => {
        const { evidence, generation } = summary;
        if (!!evidence !== !!generation) throw new Error("Summary evidence and generation metadata must be saved together");
        if (evidence) {
          const segments = db.prepare("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx").all(id) as unknown as Transcript["segments"];
          if (evidence.revision !== transcriptRevision({ segments })) throw new Error("Summary evidence belongs to a different Transcript");
          const check = (refs: number[], speaker?: string) => {
            if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length || refs.some(ref => !Number.isInteger(ref) || ref < 0 || ref >= segments.length)
              || (speaker && !refs.some(ref => segments[ref]?.speaker === speaker))) throw new Error("Invalid Summary evidence");
          };
          check(evidence.tldr);
          if (evidence.participants.length !== summary.participants.length) throw new Error("Summary evidence does not match its points");
          evidence.participants.forEach((participant, i) => {
            const point = summary.participants[i]!;
            if (participant.speaker !== point.speaker || participant.said.length !== point.said.length) throw new Error("Summary evidence does not match its points");
            participant.said.forEach(refs => check(refs, participant.speaker));
          });
        }
        db.prepare("INSERT OR REPLACE INTO summaries (meeting_id, tldr, participants_json) VALUES (?, ?, ?)")
          .run(id, summary.tldr, JSON.stringify(summary.participants));
        db.prepare("DELETE FROM summary_artifacts WHERE meeting_id = ?").run(id);
        if (evidence && generation) db.prepare("INSERT INTO summary_artifacts (meeting_id, revision, evidence_json, generation_json) VALUES (?, ?, ?, ?)")
          .run(id, evidence.revision, JSON.stringify(evidence), JSON.stringify(generation));
        reindex(id);
      });
    },

    renameParticipant(id, label, name) {
      const r = db.prepare("UPDATE participants SET name = ? WHERE meeting_id = ? AND label = ?").run(name, id, label);
      if (r.changes === 0) throw new Error(`Meeting ${id} has no Participant "${label}"`);
    },

    saveAudio(id, tracks) {
      db.prepare("UPDATE meetings SET mic_path = ?, system_path = ? WHERE id = ?").run(tracks.micPath, tracks.systemPath, id);
    },

    clearAudio(id) {
      db.prepare("UPDATE meetings SET mic_path = NULL, system_path = NULL WHERE id = ?").run(id);
    },

    deleteMeeting(id) {
      inTransaction(() => {
        db.prepare("DELETE FROM search_index WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM passage_index WHERE meeting_id = ?").run(id);
        db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
      });
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
      const artifact = db.prepare("SELECT evidence_json, generation_json FROM summary_artifacts WHERE meeting_id = ?").get(id) as { evidence_json: string; generation_json: string } | undefined;
      return {
        id: row.id,
        app: row.app,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        state: row.state,
        error: row.error,
        participants,
        transcript: { segments },
        summary: s ? { tldr: s.tldr, participants: JSON.parse(s.participants_json),
          ...(artifact ? { evidence: JSON.parse(artifact.evidence_json), generation: JSON.parse(artifact.generation_json) } : {}) } : null,
        audio: row.mic_path && row.system_path ? { micPath: row.mic_path, systemPath: row.system_path } : null,
      };
    },

    listMeetings() {
      const rows = db
        .prepare("SELECT id, app, started_at, state FROM meetings ORDER BY started_at DESC, id DESC")
        .all() as unknown as Pick<MeetingRow, "id" | "app" | "started_at" | "state">[];
      return rows.map((r) => ({ id: r.id, app: r.app, startedAt: r.started_at, state: r.state }));
    },
    searchMeetings(query) {
      const expression = searchExpression(query);
      if (!expression) return [];
      const rows = db
        .prepare(
          `SELECT m.id, m.app, m.started_at, m.state FROM search_index
           JOIN meetings m ON m.id = search_index.meeting_id
           WHERE search_index MATCH ? ORDER BY m.started_at DESC, m.id DESC`,
        )
        .all(expression) as unknown as Pick<MeetingRow, "id" | "app" | "started_at" | "state">[];
      return rows.map((r) => ({ id: r.id, app: r.app, startedAt: r.started_at, state: r.state }));
    },

    listPassages(meetingId, revision) {
      return passageRows(db.prepare("SELECT p.* FROM passages p JOIN meetings m ON m.id = p.meeting_id WHERE p.meeting_id = ? AND p.revision = ? ORDER BY p.idx, p.id")
        .all(meetingId, revision));
    },

    searchPassages(meetingId, revision, query, limit = 8) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Passage result limit must be between 1 and 100");
      const words = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 64);
      if (!words.length) return [];
      const expression = words.map(word => `"${word}"`).join(" OR ");
      return passageRows(db.prepare(`SELECT p.* FROM passage_index
        JOIN passages p ON p.id = passage_index.passage_id AND p.meeting_id = passage_index.meeting_id AND p.revision = passage_index.revision
        JOIN meetings m ON m.id = p.meeting_id
        WHERE passage_index MATCH ? AND p.meeting_id = ? AND p.revision = ?
        ORDER BY bm25(passage_index), p.idx, p.id LIMIT ?`).all(expression, meetingId, revision, limit));
    },

    createChatRequest(input) {
      if (!input.id || input.id.length > 128 || !Number.isInteger(input.meetingId) || input.meetingId < 1
        || !input.question.trim() || input.question.length > 2000 || !Number.isFinite(Date.parse(input.createdAt))) {
        throw new Error("Invalid chat request");
      }
      const existing = db.prepare("SELECT * FROM chat_requests WHERE id = ?").get(input.id) as ChatRow | undefined;
      if (existing) {
        if (existing.meeting_id === input.meetingId && existing.revision === input.revision && existing.question === input.question) return chatRecord(existing);
        throw new Error("This chat request id is already in use");
      }
      if (!db.prepare("SELECT 1 FROM meetings WHERE id = ?").get(input.meetingId)) throw new Error("This Meeting no longer exists");
      const segments = db.prepare("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx")
        .all(input.meetingId) as unknown as Transcript["segments"];
      if (input.revision !== transcriptRevision({ segments })) throw new Error("This chat request belongs to an older Transcript");
      db.prepare("INSERT INTO chat_requests (id, meeting_id, revision, question, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)")
        .run(input.id, input.meetingId, input.revision, input.question, input.createdAt);
      return chatRecord(db.prepare("SELECT * FROM chat_requests WHERE id = ?").get(input.id) as ChatRow);
    },

    getChatHistory(meetingId) {
      return (db.prepare("SELECT * FROM chat_requests WHERE meeting_id = ? ORDER BY rowid").all(meetingId) as unknown as ChatRow[]).map(chatRecord);
    },

    updateChatRequest(id, revision, patch) {
      const row = db.prepare("SELECT * FROM chat_requests WHERE id = ? AND revision = ? AND status IN ('queued','retrieving','generating')")
        .get(id, revision) as ChatRow | undefined;
      if (!row) return false;
      if (!["queued", "retrieving", "generating", "completed", "failed", "cancelled", "interrupted"].includes(patch.status)) throw new Error("Invalid chat status");
      const segments = db.prepare("SELECT start, end, speaker, text FROM segments WHERE meeting_id = ? ORDER BY idx")
        .all(row.meeting_id) as unknown as Transcript["segments"];
      if (revision !== transcriptRevision({ segments })) return false;
      const { answer, generation } = patch;
      if (patch.status === "completed") {
        if (!answer || !generation) throw new Error("Completed chat needs an answer and generation metadata");
        if (typeof answer.text !== "string" || !answer.text.trim() || typeof answer.sufficient !== "boolean" || !Array.isArray(answer.refs)
          || answer.refs.some(ref => !Number.isInteger(ref) || ref < 0 || ref >= segments.length)
          || new Set(answer.refs).size !== answer.refs.length || (answer.sufficient ? !answer.refs.length : !!answer.refs.length)) {
          throw new Error("Invalid chat answer evidence");
        }
      } else if (answer) throw new Error("Only completed chat can contain an answer");
      if (generation && (typeof generation.model !== "string" || !generation.model || typeof generation.promptVersion !== "string"
        || !generation.promptVersion || !Number.isFinite(generation.elapsedMs) || generation.elapsedMs < 0
        || !Number.isInteger(generation.calls) || generation.calls < 0 || !Number.isInteger(generation.retrievalCalls) || generation.retrievalCalls < 0
        || !["full", "fts", "scan"].includes(generation.retrievalMode) || typeof generation.exhaustive !== "boolean"
        || [generation.promptTokens, generation.outputTokens].some(value => value !== undefined && (!Number.isFinite(value) || value < 0)))) {
        throw new Error("Invalid chat generation metadata");
      }
      if (patch.error !== undefined && typeof patch.error !== "string") throw new Error("Invalid chat error");
      const result = db.prepare(`UPDATE chat_requests SET status = ?, answer_json = ?, error = ?, generation_json = ?
        WHERE id = ? AND revision = ? AND status IN ('queued','retrieving','generating')`)
        .run(patch.status, answer ? JSON.stringify(answer) : null, patch.error ?? null, generation ? JSON.stringify(generation) : null, id, revision);
      return result.changes > 0;
    },

    clearChat(meetingId) {
      db.prepare("DELETE FROM chat_requests WHERE meeting_id = ?").run(meetingId);
    },

    interruptChats() {
      db.prepare(`UPDATE chat_requests SET status = 'interrupted', answer_json = NULL, generation_json = NULL,
        error = 'The app stopped before this answer completed. Retry the question.' WHERE status IN ('queued','retrieving','generating')`).run();
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


interface PassageRow {
  id: number;
  meeting_id: number;
  revision: string;
  idx: number;
  refs_json: string;
  text: string;
}


interface ChatRow {
  id: string;
  meeting_id: number;
  revision: string;
  question: string;
  status: ChatStatus;
  answer_json: string | null;
  error: string | null;
  generation_json: string | null;
  created_at: string;
}
function chatRecord(row: ChatRow): ChatRecord {
  return { id: row.id, meetingId: row.meeting_id, revision: row.revision, question: row.question,
    status: row.status, answer: row.answer_json ? JSON.parse(row.answer_json) : null, error: row.error,
    generation: row.generation_json ? JSON.parse(row.generation_json) : null, createdAt: row.created_at };
}
