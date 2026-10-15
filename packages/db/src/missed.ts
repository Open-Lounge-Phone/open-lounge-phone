// Missed calls (migration 0029, docs/phone-ux.md "Missed calls"): calls that rang a person or a
// household phone and nobody answered, with no message left. One row per call; a list shows them
// grouped by caller, newest first. Clearing marks them seen; seen rows stay (until the space's
// history setting removes them) as proof that this caller called, so a phone may call them back.
import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

/** Whose missed calls: a person (all their phones and apps) or a household phone (a kid's). */
export type MissedOwner = { accountId: string } | { deviceId: string };

export interface MissedCall {
  id: string;
  householdId: string;
  accountId: string | null;
  deviceId: string | null;
  callId: string;
  fromLabel: string;
  /** The caller as the call log names them: `user:<id>`, `device:<id>` or `handle@host`. */
  fromPeer: string;
  at: number;
  seenAt: number | null;
}

/** Unseen missed calls from one caller, for a list. */
export interface MissedGroup {
  /** The newest call's row id (what a phone calls back with). */
  id: string;
  householdId: string;
  fromLabel: string;
  fromPeer: string;
  /** The newest call. */
  at: number;
  count: number;
}

type Row = {
  id: string;
  household_id: string;
  account_id: string | null;
  device_id: string | null;
  call_id: string;
  from_label: string;
  from_peer: string;
  at: number;
  seen_at: number | null;
};

const toMissed = (r: Row): MissedCall => ({
  id: r.id,
  householdId: r.household_id,
  accountId: r.account_id,
  deviceId: r.device_id,
  callId: r.call_id,
  fromLabel: r.from_label,
  fromPeer: r.from_peer,
  at: r.at,
  seenAt: r.seen_at,
});

/** `account_id = ?` or `device_id = ?` for an owner, and its parameter. */
const whose = (o: MissedOwner): [string, string] =>
  "accountId" in o ? ["account_id = ?", o.accountId] : ["device_id = ?", o.deviceId];

export class MissedCallStore {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async add(m: {
    householdId: string;
    owner: MissedOwner;
    callId: string;
    fromLabel: string;
    fromPeer: string;
    at: number;
  }): Promise<string> {
    const id = newId("mc");
    await this.sql.run(
      `INSERT INTO missed_calls
         (id, household_id, account_id, device_id, call_id, from_label, from_peer, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      m.householdId,
      "accountId" in m.owner ? m.owner.accountId : null,
      "deviceId" in m.owner ? m.owner.deviceId : null,
      m.callId,
      m.fromLabel.slice(0, 24) || "Someone",
      m.fromPeer,
      m.at,
    );
    return id;
  }

  async get(id: string): Promise<MissedCall | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM missed_calls WHERE id = ?", id);
    return r ? toMissed(r) : undefined;
  }

  /** Unseen missed calls grouped by caller, newest first (at most `limit` callers). */
  async list(owner: MissedOwner, limit = 8): Promise<MissedGroup[]> {
    const [where, param] = whose(owner);
    const rows = await this.sql.all<Row>(
      `SELECT * FROM missed_calls WHERE ${where} AND seen_at IS NULL ORDER BY at DESC LIMIT 500`,
      param,
    );
    const groups = new Map<string, MissedGroup>();
    for (const r of rows) {
      const g = groups.get(r.from_peer);
      if (g) g.count++;
      else {
        groups.set(r.from_peer, {
          id: r.id,
          householdId: r.household_id,
          fromLabel: r.from_label,
          fromPeer: r.from_peer,
          at: r.at,
          count: 1,
        });
      }
    }
    return [...groups.values()].slice(0, limit);
  }

  /** Marks them all seen ("clear"); answers how many were unseen. */
  async clear(owner: MissedOwner, now: number): Promise<number> {
    const [where, param] = whose(owner);
    const r = await this.sql.run(
      `UPDATE missed_calls SET seen_at = ? WHERE ${where} AND seen_at IS NULL`,
      now,
      param,
    );
    return r.changes;
  }

  /**
   * The caller left a message after all: their newest unseen missed call since `since` becomes
   * voicemail (seen). Answers whether there was one.
   */
  async becameVoicemail(owner: MissedOwner, fromPeer: string, since: number, now: number) {
    const [where, param] = whose(owner);
    const r = await this.sql.run(
      `UPDATE missed_calls SET seen_at = ? WHERE id = (
         SELECT id FROM missed_calls
         WHERE ${where} AND from_peer = ? AND at >= ? AND seen_at IS NULL
         ORDER BY at DESC LIMIT 1)`,
      now,
      param,
      fromPeer,
      since,
    );
    return r.changes > 0;
  }

  /** A person's missed calls, seen or not, oldest first (their data export). */
  async ofAccount(accountId: string): Promise<MissedCall[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM missed_calls WHERE account_id = ? ORDER BY at",
      accountId,
    );
    return rows.map(toMissed);
  }
}
