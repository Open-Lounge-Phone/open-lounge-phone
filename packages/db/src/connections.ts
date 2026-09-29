import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type ConnectionState = "requested" | "active" | "declined" | "blocked";
export type ConnectionDirection = "in" | "out" | "none";

/** `peerHost` for someone on this server. */
export const LOCAL_HOST = "";
/** `peerHandle` of a row that blocks a whole server. */
export const WHOLE_SERVER = "*";

/** One account's view of one other person (see migration 0008). */
export interface Connection {
  id: string;
  accountId: string;
  /** '' = this server. */
  peerHost: string;
  peerHandle: string;
  /** The peer's stable account id on their server, once known. */
  peerAccount: string | null;
  peerName: string;
  state: ConnectionState;
  direction: ConnectionDirection;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  /** Pending knocks expire; a decline blocks re-knocks until then. */
  expiresAt: number | null;
  /** Last presence they shared (only if they opted in); null = never. */
  presence: { online: boolean; available: boolean; at: number } | null;
}

type Row = {
  id: string;
  account_id: string;
  peer_host: string;
  peer_handle: string;
  peer_account: string | null;
  peer_name: string;
  state: ConnectionState;
  direction: ConnectionDirection;
  note: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  presence_online?: number | null;
  presence_available?: number | null;
  presence_at?: number | null;
};
const toConnection = (r: Row): Connection => ({
  id: r.id,
  accountId: r.account_id,
  peerHost: r.peer_host,
  peerHandle: r.peer_handle,
  peerAccount: r.peer_account,
  peerName: r.peer_name,
  state: r.state,
  direction: r.direction,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
  presence:
    r.presence_at != null
      ? {
          online: r.presence_online === 1,
          available: r.presence_available === 1,
          at: r.presence_at,
        }
      : null,
});

export const KNOCK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DECLINE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a row still means something at `now` (expired knocks and cooldowns don't). */
export function connectionLive(c: Connection, now: number): boolean {
  if (c.state === "requested" || c.state === "declined") {
    return c.expiresAt === null || c.expiresAt > now;
  }
  return true;
}

/** Connections, server keys, nonces, server blocks and rate limits. */
export class ConnectionStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async get(id: string): Promise<Connection | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM connections WHERE id = ?", id);
    return r && toConnection(r);
  }

  /** The account's row about `handle@host` (host '' = local), live or not. */
  async find(accountId: string, host: string, handle: string): Promise<Connection | undefined> {
    const r = await this.sql.first<Row>(
      "SELECT * FROM connections WHERE account_id = ? AND peer_host = ? AND peer_handle = ?",
      accountId,
      host,
      handle,
    );
    return r && toConnection(r);
  }

  /**
   * The account's row about a person, by stable id if known (handles change), else by handle.
   */
  async findPeer(
    accountId: string,
    host: string,
    peer: { id: string; handle: string },
  ): Promise<Connection | undefined> {
    const r = await this.sql.first<Row>(
      `SELECT * FROM connections WHERE account_id = ? AND peer_host = ?
       AND (peer_account = ? OR (peer_account IS NULL AND peer_handle = ?))
       ORDER BY peer_account IS NULL LIMIT 1`,
      accountId,
      host,
      peer.id,
      peer.handle,
    );
    return r && toConnection(r);
  }

  async list(accountId: string): Promise<Connection[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM connections WHERE account_id = ? ORDER BY state, peer_name, peer_handle",
      accountId,
    );
    return rows.map(toConnection);
  }

  /** Creates or replaces the account's row about `peerHost`/`peerHandle`. */
  async put(
    c: Omit<Connection, "id" | "createdAt" | "updatedAt" | "presence">,
    now: number,
  ): Promise<Connection> {
    const id = newId("con");
    await this.sql.run(
      `INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
         state, direction, note, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, peer_host, peer_handle) DO UPDATE SET
         peer_account = COALESCE(excluded.peer_account, peer_account),
         peer_name = CASE WHEN excluded.peer_name = '' THEN peer_name ELSE excluded.peer_name END,
         state = excluded.state, direction = excluded.direction, note = excluded.note,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at`,
      id,
      c.accountId,
      c.peerHost,
      c.peerHandle,
      c.peerAccount,
      c.peerName,
      c.state,
      c.direction,
      c.note,
      now,
      now,
      c.expiresAt,
    );
    await this.clearGrantsUnlessActive(c.accountId, c.peerHost, c.peerHandle, c.state);
    return (await this.find(c.accountId, c.peerHost, c.peerHandle)) as Connection;
  }

  /** Changes a row's state; anything but `active` takes its phone allow-list entries away. */
  async setState(
    id: string,
    state: ConnectionState,
    now: number,
    extra: {
      expiresAt?: number | null;
      direction?: ConnectionDirection;
      peerAccount?: string;
      peerName?: string;
      peerHandle?: string;
    } = {},
  ): Promise<void> {
    await this.sql.run(
      `UPDATE connections SET state = ?, updated_at = ?,
         expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
         direction = COALESCE(?, direction),
         peer_account = COALESCE(?, peer_account),
         peer_name = COALESCE(?, peer_name),
         peer_handle = COALESCE(?, peer_handle)
       WHERE id = ?`,
      state,
      now,
      extra.expiresAt !== undefined ? 1 : 0,
      extra.expiresAt ?? null,
      extra.direction ?? null,
      extra.peerAccount ?? null,
      extra.peerName ?? null,
      extra.peerHandle ?? null,
      id,
    );
    if (state !== "active") {
      await this.sql.batch([
        { query: "DELETE FROM remote_contacts WHERE connection_id = ?", params: [id] },
        { query: "DELETE FROM connection_phones WHERE connection_id = ?", params: [id] },
      ]);
    }
  }

  private async clearGrantsUnlessActive(
    accountId: string,
    host: string,
    handle: string,
    state: ConnectionState,
  ): Promise<void> {
    if (state === "active") return;
    await this.sql.run(
      `DELETE FROM remote_contacts WHERE connection_id IN
         (SELECT id FROM connections WHERE account_id = ? AND peer_host = ? AND peer_handle = ?)`,
      accountId,
      host,
      handle,
    );
  }

  async delete(id: string): Promise<void> {
    await this.sql.run("DELETE FROM connections WHERE id = ?", id);
  }

  /** Whether the account blocked this person or their whole server. */
  async blocked(
    accountId: string,
    host: string,
    peer: { id: string; handle: string },
  ): Promise<boolean> {
    const r = await this.sql.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM connections WHERE account_id = ? AND peer_host = ?
       AND state = 'blocked' AND (peer_handle = ? OR peer_account = ? OR peer_handle = ?)`,
      accountId,
      host,
      WHOLE_SERVER,
      peer.id,
      peer.handle,
    );
    return (r?.n ?? 0) > 0;
  }

  /** Every account on this server with an active connection to this person. */
  async activeWith(host: string, peer: { id: string; handle: string }): Promise<Connection[]> {
    const rows = await this.sql.all<Row>(
      `SELECT * FROM connections WHERE peer_host = ? AND state = 'active'
       AND (peer_account = ? OR (peer_account IS NULL AND peer_handle = ?))`,
      host,
      peer.id,
      peer.handle,
    );
    return rows.map(toConnection);
  }

  /** Phones on the other side that this connection lets its owner call. */
  async phones(connectionId: string): Promise<{ deviceId: string; label: string }[]> {
    const rows = await this.sql.all<{ device_id: string; label: string }>(
      "SELECT device_id, label FROM connection_phones WHERE connection_id = ? ORDER BY label",
      connectionId,
    );
    return rows.map((r) => ({ deviceId: r.device_id, label: r.label }));
  }

  /** Replaces the phones a connection shares with us. */
  async setPhones(connectionId: string, phones: { id: string; label: string }[]): Promise<void> {
    await this.sql.batch([
      { query: "DELETE FROM connection_phones WHERE connection_id = ?", params: [connectionId] },
      ...phones.map((p) => ({
        query:
          "INSERT OR REPLACE INTO connection_phones (connection_id, device_id, label) VALUES (?, ?, ?)",
        params: [connectionId, p.id, p.label],
      })),
    ]);
  }

  async setPresence(
    connectionId: string,
    presence: { online: boolean; available: boolean },
    now: number,
  ): Promise<void> {
    await this.sql.run(
      "UPDATE connections SET presence_online = ?, presence_available = ?, presence_at = ? WHERE id = ?",
      presence.online ? 1 : 0,
      presence.available ? 1 : 0,
      now,
      connectionId,
    );
  }

  // --- rate limits ------------------------------------------------------------------

  /**
   * Counts one event in a fixed window and says whether it is within `limit`. Over-limit events
   * are counted too, so a flood doesn't reset itself.
   */
  async hit(bucket: string, windowMs: number, limit: number, now: number): Promise<boolean> {
    const start = now - windowMs;
    // Now and then, forget counters nobody has touched for over a month.
    if (Math.random() < 0.01) {
      await this.sql.run("DELETE FROM rate_limits WHERE window_start < ?", now - 35 * 86_400_000);
    }
    const r = await this.sql.first<{ count: number }>(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
       RETURNING count`,
      bucket,
      now,
      start,
      start,
    );
    return (r?.count ?? 1) <= limit;
  }

  /** Events counted in the bucket's current window (0 if it has lapsed). */
  async counted(bucket: string, windowMs: number, now: number): Promise<number> {
    const r = await this.sql.first<{ count: number; window_start: number }>(
      "SELECT count, window_start FROM rate_limits WHERE bucket = ?",
      bucket,
    );
    return r && r.window_start > now - windowMs ? r.count : 0;
  }

  // --- server keys, nonces, blocks ----------------------------------------------------

  async pinnedKey(host: string): Promise<string | undefined> {
    const r = await this.sql.first<{ public_key: string }>(
      "SELECT public_key FROM server_keys WHERE host = ?",
      host,
    );
    return r?.public_key;
  }

  /** Pins a key (first contact) or replaces it (a rotation the old key signed). */
  async pinKey(host: string, key: string, now: number): Promise<void> {
    await this.sql.run(
      `INSERT INTO server_keys (host, public_key, first_seen, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT(host) DO UPDATE SET public_key = excluded.public_key, last_seen = excluded.last_seen`,
      host,
      key,
      now,
      now,
    );
  }

  /** Records a key that didn't match the pinned one (shown to the operator). */
  async rejectKey(host: string, key: string, now: number): Promise<void> {
    await this.sql.run(
      "UPDATE server_keys SET rejected_key = ?, rejected_at = ? WHERE host = ?",
      key,
      now,
      host,
    );
  }

  async keyAlerts(): Promise<{ host: string; rejectedAt: number }[]> {
    const rows = await this.sql.all<{ host: string; rejected_at: number }>(
      "SELECT host, rejected_at FROM server_keys WHERE rejected_key IS NOT NULL ORDER BY rejected_at DESC",
    );
    return rows.map((r) => ({ host: r.host, rejectedAt: r.rejected_at }));
  }

  /** Records a signature nonce; false if it was already used. */
  async useNonce(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    await this.sql.run("DELETE FROM fed_nonces WHERE expires_at <= ?", now);
    const { changes } = await this.sql.run(
      "INSERT OR IGNORE INTO fed_nonces (nonce, expires_at) VALUES (?, ?)",
      nonce,
      expiresAt,
    );
    return changes === 1;
  }

  async blockServer(host: string, reason: string | null, now: number): Promise<void> {
    await this.sql.run(
      "INSERT OR REPLACE INTO blocked_servers (host, reason, created_at) VALUES (?, ?, ?)",
      host,
      reason,
      now,
    );
  }

  async unblockServer(host: string): Promise<void> {
    await this.sql.run("DELETE FROM blocked_servers WHERE host = ?", host);
  }

  async serverBlocked(host: string): Promise<boolean> {
    return !!(await this.sql.first("SELECT 1 AS x FROM blocked_servers WHERE host = ?", host));
  }

  async blockedServers(): Promise<{ host: string; reason: string | null; createdAt: number }[]> {
    const rows = await this.sql.all<{ host: string; reason: string | null; created_at: number }>(
      "SELECT * FROM blocked_servers ORDER BY host",
    );
    return rows.map((r) => ({ host: r.host, reason: r.reason, createdAt: r.created_at }));
  }
}
