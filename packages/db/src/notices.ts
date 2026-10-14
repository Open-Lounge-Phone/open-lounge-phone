// Notices (migration 0024, docs/notices.md): short messages from a space's owner, admins or
// guardians to its phones, with an optional recording. Local to the space.
import { newId, newToken } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export interface Notice {
  id: string;
  householdId: string;
  createdBy: string | null;
  authorName: string;
  lines: string[];
  /** Only these phones; null = every phone of the space. */
  deviceIds: string[] | null;
  audio: { blobKey: string; mime: string; durationMs: number; token: string } | null;
  createdAt: number;
  expiresAt: number;
  /** Taken down early. */
  endedAt: number | null;
}

/** Rows are kept this long after a notice is over (for the admins' list), then deleted. */
export const NOTICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

type Row = {
  id: string;
  household_id: string;
  created_by: string | null;
  author_name: string;
  line1: string;
  line2: string | null;
  device_ids: string | null;
  audio_blob: string | null;
  audio_mime: string | null;
  audio_ms: number | null;
  play_token: string | null;
  created_at: number;
  expires_at: number;
  ended_at: number | null;
};

const toNotice = (r: Row): Notice => {
  let deviceIds: string[] | null = null;
  if (r.device_ids) {
    try {
      deviceIds = JSON.parse(r.device_ids) as string[];
    } catch {
      deviceIds = [];
    }
  }
  return {
    id: r.id,
    householdId: r.household_id,
    createdBy: r.created_by,
    authorName: r.author_name,
    lines: r.line2 ? [r.line1, r.line2] : [r.line1],
    deviceIds,
    audio:
      r.audio_blob && r.play_token
        ? {
            blobKey: r.audio_blob,
            mime: r.audio_mime ?? "audio/wav",
            durationMs: r.audio_ms ?? 0,
            token: r.play_token,
          }
        : null,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    endedAt: r.ended_at,
  };
};

export class NoticeStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async create(
    n: {
      householdId: string;
      createdBy: string | null;
      authorName: string;
      lines: string[];
      deviceIds: string[] | null;
      expiresAt: number;
    },
    now: number,
  ): Promise<Notice> {
    const id = newId("ntc");
    // Strictly after the space's latest notice, so "the newest" is never a tie (two posts in the
    // same millisecond would otherwise fall back to comparing random ids).
    await this.sql.run(
      `INSERT INTO notices (id, household_id, created_by, author_name, line1, line2, device_ids,
         created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?,
         MAX(?, COALESCE((SELECT MAX(created_at) + 1 FROM notices WHERE household_id = ?), 0)), ?)`,
      id,
      n.householdId,
      n.createdBy,
      n.authorName.slice(0, 64),
      n.lines[0] ?? "",
      n.lines[1] ?? null,
      n.deviceIds ? JSON.stringify(n.deviceIds) : null,
      now,
      n.householdId,
      n.expiresAt,
    );
    return (await this.get(id)) as Notice;
  }

  async get(id: string): Promise<Notice | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM notices WHERE id = ?", id);
    return r && toNotice(r);
  }

  /** A space's notices, newest first (live ones and those that ended in the last week). */
  async ofSpace(householdId: string, limit = 50): Promise<Notice[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM notices WHERE household_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      householdId,
      limit,
    );
    return rows.map(toNotice);
  }

  /** Notices that may still be up (not taken down, not expired at `now`). */
  async live(householdId: string, now: number): Promise<Notice[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM notices WHERE household_id = ? AND ended_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC`,
      householdId,
      now,
    );
    return rows.map(toNotice);
  }

  /** Adds (or replaces) the recording; returns the old audio's blob key. */
  async setAudio(
    id: string,
    a: { blobKey: string; mime: string; durationMs: number },
  ): Promise<{ old: string | undefined; token: string }> {
    const before = (await this.get(id))?.audio?.blobKey;
    const token = newToken();
    await this.sql.run(
      `UPDATE notices SET audio_blob = ?, audio_mime = ?, audio_ms = ?, play_token = ?
       WHERE id = ?`,
      a.blobKey,
      a.mime,
      a.durationMs,
      token,
      id,
    );
    return { old: before, token };
  }

  /** Takes a notice down early; false if it was already over. */
  async end(id: string, now: number): Promise<boolean> {
    const { changes } = await this.sql.run(
      "UPDATE notices SET ended_at = ? WHERE id = ? AND ended_at IS NULL AND expires_at > ?",
      now,
      id,
      now,
    );
    return changes === 1;
  }

  async dismiss(id: string, deviceId: string, now: number): Promise<void> {
    await this.sql.run(
      "INSERT OR IGNORE INTO notice_dismissals (notice_id, device_id, at) VALUES (?, ?, ?)",
      id,
      deviceId,
      now,
    );
  }

  /** The notices (of these) a phone dismissed. */
  async dismissed(deviceId: string, ids: string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.sql.all<{ notice_id: string }>(
      `SELECT notice_id FROM notice_dismissals WHERE device_id = ? AND notice_id IN
       (${ids.map(() => "?").join(", ")})`,
      deviceId,
      ...ids,
    );
    return new Set(rows.map((r) => r.notice_id));
  }

  /**
   * Housekeeping for a space: recordings of notices that are over are let go (their blob keys
   * are returned, for the caller to delete), and rows over a week old go.
   */
  async sweep(householdId: string, now: number): Promise<string[]> {
    const over = await this.sql.all<{ id: string; audio_blob: string }>(
      `SELECT id, audio_blob FROM notices WHERE household_id = ? AND audio_blob IS NOT NULL
       AND (ended_at IS NOT NULL OR expires_at <= ?)`,
      householdId,
      now,
    );
    await this.sql.batch([
      ...over.map((r) => ({
        query:
          "UPDATE notices SET audio_blob = NULL, audio_mime = NULL, play_token = NULL WHERE id = ?",
        params: [r.id],
      })),
      {
        query: `DELETE FROM notices WHERE household_id = ?
          AND COALESCE(ended_at, expires_at) < ?`,
        params: [householdId, now - NOTICE_KEEP_MS],
      },
    ]);
    return over.map((r) => r.audio_blob);
  }
}
