// Sign-in records: recovery codes (hashes only), the session list, and outstanding invites and
// sign-in links. Sessions are opened and resolved by `Store` (openSession, sessionForToken).
import { constantTimeEqual, type SessionVia } from "@openloungephone/core";
import { sha256 } from "./crypto.ts";
import type { Sql } from "./sql.ts";
import type { Invite, Role } from "./store.ts";

export type InviteRow = {
  id: string | null;
  household_id: string;
  user_id: string | null;
  name: string;
  role: Role;
  expires_at: number;
  created_by: string;
  created_at: number;
};
export const toInvite = (r: InviteRow): Invite => ({
  id: r.id ?? "",
  householdId: r.household_id,
  userId: r.user_id,
  name: r.name,
  role: r.role,
  expiresAt: r.expires_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** How a session is opened (see `Store.openSession`). */
export interface SessionOptions {
  via?: SessionVia;
  /** "Chrome on Mac" (from the User-Agent). */
  label?: string;
  /** A passkey backs this session (it signed in with one, or made one): it slides. */
  passkey?: boolean;
  /** A recovery code's session: it may only add a passkey. */
  limited?: boolean;
  /** Default `SESSION_TTL_MS`. */
  ttlMs?: number;
}

/** A signed-in browser or app (never its token). */
export interface Session {
  id: string;
  accountId: string;
  userId: string | null;
  label: string | null;
  via: SessionVia | null;
  passkey: boolean;
  limited: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
}
export type SessionRow = {
  token_hash: string;
  id: string | null;
  account_id: string;
  user_id: string | null;
  label: string | null;
  via: string | null;
  passkey: number | null;
  limited: number | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
};
export const toSession = (r: SessionRow): Session => ({
  // Rows from before 0027 got an id there; '' never matches a request.
  id: r.id ?? "",
  accountId: r.account_id,
  userId: r.user_id,
  label: r.label,
  via: (r.via as SessionVia | null) ?? null,
  passkey: r.passkey === 1,
  limited: r.limited === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  expiresAt: r.expires_at,
});

/** The stored form of a recovery code: a hash bound to its account. */
export const recoveryHash = (accountId: string, normalizedCode: string) =>
  sha256(`olp-recovery-v1:${accountId}:${normalizedCode}`);

/** Compared against when a handle doesn't exist, so a wrong handle costs the same as a wrong code. */
const DUMMY_HASH = "x".repeat(43);

export class AuthStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  // --- recovery codes -----------------------------------------------------------------------

  /** Stores a new code's hash (the old one stops working). */
  async setRecoveryCode(accountId: string, normalizedCode: string, now: number): Promise<void> {
    await this.sql.run(
      "UPDATE accounts SET recovery_hash = ?, recovery_created_at = ? WHERE id = ?",
      await recoveryHash(accountId, normalizedCode),
      now,
      accountId,
    );
  }

  /**
   * Checks a recovery code: true when it is this account's code. It stays valid: it's used up
   * only when the recovery ends in a new passkey (`consumeRecoveryCode`). The comparison takes
   * the same time whether or not the account has a code.
   */
  async checkRecoveryCode(accountId: string | undefined, normalizedCode: string): Promise<boolean> {
    // The same query whether or not the handle named an account.
    const row = await this.sql.first<{ recovery_hash: string | null }>(
      "SELECT recovery_hash FROM accounts WHERE id = ?",
      accountId ?? "",
    );
    const stored = row?.recovery_hash ?? DUMMY_HASH;
    const given = await recoveryHash(accountId ?? "", normalizedCode);
    return constantTimeEqual(stored, given) && !!accountId && !!row?.recovery_hash;
  }

  /**
   * Uses up an account's recovery code when a recovery ends in a new passkey: true when there
   * was one to use (only one of two racing recoveries gets it).
   */
  async consumeRecoveryCode(accountId: string): Promise<boolean> {
    const { changes } = await this.sql.run(
      `UPDATE accounts SET recovery_hash = NULL, recovery_created_at = NULL
       WHERE id = ? AND recovery_hash IS NOT NULL`,
      accountId,
    );
    return changes === 1;
  }

  // --- sessions -----------------------------------------------------------------------------

  /** An account's sessions that haven't expired, most recently used first. */
  async sessions(accountId: string, now: number): Promise<Session[]> {
    const rows = await this.sql.all<SessionRow>(
      `SELECT * FROM sessions WHERE account_id = ? AND expires_at > ?
       ORDER BY COALESCE(last_used_at, created_at) DESC`,
      accountId,
      now,
    );
    return rows.map(toSession);
  }

  /** Ends one of an account's sessions by its public id. */
  async endSession(accountId: string, id: string): Promise<boolean> {
    const { changes } = await this.sql.run(
      "DELETE FROM sessions WHERE account_id = ? AND id = ?",
      accountId,
      id,
    );
    return changes === 1;
  }

  /** Ends every session of an account except `keepId` (none kept when undefined). */
  async endSessions(accountId: string, keepId?: string): Promise<string[]> {
    const ended = await this.sql.all<{ id: string | null }>(
      "SELECT id FROM sessions WHERE account_id = ? AND (id IS NULL OR id != ?)",
      accountId,
      keepId ?? "",
    );
    await this.sql.run(
      "DELETE FROM sessions WHERE account_id = ? AND (id IS NULL OR id != ?)",
      accountId,
      keepId ?? "",
    );
    return ended.map((r) => r.id ?? "").filter(Boolean);
  }

  /**
   * A passkey now backs this session (it made one): it slides from now on, and a recovery
   * session becomes a full one.
   */
  async sessionGotPasskey(id: string, expiresAt: number, now: number): Promise<void> {
    await this.sql.run(
      `UPDATE sessions SET passkey = 1, limited = 0, last_used_at = ?,
         expires_at = MAX(expires_at, ?) WHERE id = ?`,
      now,
      expiresAt,
      id,
    );
  }

  // --- invites and sign-in links ------------------------------------------------------------

  /** A space's invites and sign-in links that can still be used, newest first. */
  async invites(householdId: string, now: number): Promise<Invite[]> {
    const rows = await this.sql.all<InviteRow>(
      "SELECT * FROM invites WHERE household_id = ? AND expires_at > ? ORDER BY created_at DESC",
      householdId,
      now,
    );
    return rows.map(toInvite);
  }

  /** Cancels one of a space's invites or sign-in links. */
  async cancelInvite(householdId: string, id: string): Promise<Invite | undefined> {
    const row = await this.sql.first<InviteRow>(
      "SELECT * FROM invites WHERE household_id = ? AND id = ?",
      householdId,
      id,
    );
    if (!row) return undefined;
    const { changes } = await this.sql.run(
      "DELETE FROM invites WHERE household_id = ? AND id = ?",
      householdId,
      id,
    );
    return changes === 1 ? toInvite(row) : undefined;
  }

  /** Cancels a person's sign-in links (a new one replaces them). Returns how many. */
  async cancelSignInLinks(userId: string): Promise<number> {
    const { changes } = await this.sql.run("DELETE FROM invites WHERE user_id = ?", userId);
    return changes;
  }

  // --- housekeeping -------------------------------------------------------------------------

  /** Deletes expired sessions, invites and passkey challenges. */
  async purgeExpired(now: number): Promise<void> {
    await this.sql.batch([
      { query: "DELETE FROM sessions WHERE expires_at <= ?", params: [now] },
      { query: "DELETE FROM invites WHERE expires_at <= ?", params: [now] },
      { query: "DELETE FROM auth_challenges WHERE expires_at <= ?", params: [now] },
    ]);
  }
}
