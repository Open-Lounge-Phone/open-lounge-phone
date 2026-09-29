// Call recording (migration 0018, docs/security-model.md): the per-space switch, single-use
// upload tickets, and the recordings themselves.
import { newId, newToken, sha256 } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type RecordingKind = "call" | "room";
export type RecordingTranscript = "pending" | "done" | "failed" | "unavailable";

export interface Recording {
  id: string;
  householdId: string;
  kind: RecordingKind;
  callId: string;
  accountId: string | null;
  peer: string;
  peerLabel: string;
  startedAt: number;
  createdAt: number;
  durationMs: number;
  mime: string;
  blobKey: string;
  bytes: number;
  transcript: string | null;
  transcriptStatus: RecordingTranscript;
}

/** What an upload ticket stands for: one announced recording of one call or room. */
export interface RecordingTicket {
  householdId: string;
  kind: RecordingKind;
  callId: string;
  accountId: string | null;
  peer: string;
  peerLabel: string;
  startedAt: number;
}

type Row = {
  id: string;
  household_id: string;
  kind: RecordingKind;
  call_id: string;
  account_id: string | null;
  peer: string;
  peer_label: string;
  started_at: number;
  created_at: number;
  duration_ms: number;
  mime: string;
  blob_key: string;
  bytes: number;
  transcript: string | null;
  transcript_status: RecordingTranscript;
};

const toRecording = (r: Row): Recording => ({
  id: r.id,
  householdId: r.household_id,
  kind: r.kind,
  callId: r.call_id,
  accountId: r.account_id,
  peer: r.peer,
  peerLabel: r.peer_label,
  startedAt: r.started_at,
  createdAt: r.created_at,
  durationMs: r.duration_ms,
  mime: r.mime,
  blobKey: r.blob_key,
  bytes: r.bytes,
  transcript: r.transcript,
  transcriptStatus: r.transcript_status,
});

/** A long call may be recorded; the ticket lasts long enough for it and the upload after. */
export const RECORDING_TICKET_TTL_MS = 6 * 60 * 60 * 1000;

export class RecordingStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Whether a space records calls (off unless a guardian or admin turned it on). */
  async enabled(householdId: string): Promise<boolean> {
    const r = await this.sql.first<{ recording: number }>(
      "SELECT recording FROM households WHERE id = ?",
      householdId,
    );
    return r?.recording === 1;
  }

  async setEnabled(householdId: string, on: boolean): Promise<void> {
    await this.sql.run("UPDATE households SET recording = ? WHERE id = ?", on ? 1 : 0, householdId);
  }

  /** Mints the upload ticket for an announced recording. */
  async createTicket(data: RecordingTicket, now: number): Promise<string> {
    if (Math.random() < 0.05) {
      await this.sql.run("DELETE FROM recording_tickets WHERE expires_at < ?", now);
    }
    const token = newToken();
    await this.sql.run(
      "INSERT INTO recording_tickets (token_hash, data, expires_at) VALUES (?, ?, ?)",
      await sha256(token),
      JSON.stringify(data),
      now + RECORDING_TICKET_TTL_MS,
    );
    return token;
  }

  async peekTicket(token: string, now: number): Promise<RecordingTicket | undefined> {
    const r = await this.sql.first<{ data: string }>(
      "SELECT data FROM recording_tickets WHERE token_hash = ? AND expires_at > ?",
      await sha256(token),
      now,
    );
    return r ? (JSON.parse(r.data) as RecordingTicket) : undefined;
  }

  /** Uses a ticket up; only one of several concurrent takers gets it. */
  async takeTicket(token: string, now: number): Promise<RecordingTicket | undefined> {
    const data = await this.peekTicket(token, now);
    if (!data) return undefined;
    const { changes } = await this.sql.run(
      "DELETE FROM recording_tickets WHERE token_hash = ?",
      await sha256(token),
    );
    return changes === 1 ? data : undefined;
  }

  /** Stores a recording and links it to its call's call-log rows. */
  async create(r: Omit<Recording, "id" | "transcript">): Promise<Recording> {
    const rec: Recording = { ...r, id: newId("rec"), transcript: null };
    await this.sql.batch([
      {
        query: `INSERT INTO recordings (id, household_id, kind, call_id, account_id, peer,
          peer_label, started_at, created_at, duration_ms, mime, blob_key, bytes,
          transcript_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          rec.id,
          rec.householdId,
          rec.kind,
          rec.callId,
          rec.accountId,
          rec.peer,
          rec.peerLabel,
          rec.startedAt,
          rec.createdAt,
          rec.durationMs,
          rec.mime,
          rec.blobKey,
          rec.bytes,
          rec.transcriptStatus,
        ],
      },
      {
        query: `UPDATE call_log SET recording_id = ?
          WHERE household_id = ? AND call_id = ? AND recording_id IS NULL`,
        params: [rec.id, rec.householdId, rec.callId],
      },
    ]);
    return rec;
  }

  async get(id: string): Promise<Recording | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM recordings WHERE id = ?", id);
    return r && toRecording(r);
  }

  /** A space's recordings, newest first. */
  async list(householdId: string, limit = 200): Promise<Recording[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM recordings WHERE household_id = ? ORDER BY started_at DESC LIMIT ?",
      householdId,
      limit,
    );
    return rows.map(toRecording);
  }

  /** Recordings of calls an account was in (its call-log rows link them), or that it made. */
  async forAccount(accountId: string, limit = 200): Promise<Recording[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM recordings WHERE account_id = ? OR id IN
         (SELECT recording_id FROM call_log WHERE account_id = ? AND recording_id IS NOT NULL)
       ORDER BY started_at DESC LIMIT ?`,
      accountId,
      accountId,
      limit,
    );
    return rows.map(toRecording);
  }

  /** Whether an account was a party to the call this recording is of. */
  async wasParty(recordingId: string, accountId: string): Promise<boolean> {
    const r = await this.sql.first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM recordings WHERE id = ? AND account_id = ?) +
              (SELECT COUNT(*) FROM call_log WHERE recording_id = ? AND account_id = ?) AS n`,
      recordingId,
      accountId,
      recordingId,
      accountId,
    );
    return (r?.n ?? 0) > 0;
  }

  async setTranscript(id: string, status: RecordingTranscript, text: string | null): Promise<void> {
    await this.sql.run(
      "UPDATE recordings SET transcript_status = ?, transcript = ? WHERE id = ?",
      status,
      text,
      id,
    );
  }

  async delete(id: string): Promise<void> {
    await this.sql.run("DELETE FROM recordings WHERE id = ?", id);
  }

  /** Blob keys of a space's recordings (before the space is deleted). */
  async blobs(householdId: string): Promise<string[]> {
    const rows = await this.sql.all<{ k: string }>(
      "SELECT blob_key AS k FROM recordings WHERE household_id = ?",
      householdId,
    );
    return rows.map((r) => r.k);
  }
}
