import type {
  ButtonMap,
  Contact,
  QuietHoursRule,
  QuietHoursSchedule,
  Weekday,
} from "@openloungephone/core";
import { type Connection, ConnectionStore } from "./connections.ts";
import { newId, newPairingCode, newToken, sha256 } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type Role = "guardian" | "contact";

/**
 * What kind of space a household is. `home` is a family: kids' phones and quiet hours live only
 * there. `team` and `org` are for grown-ups (no kids' phones, no quiet hours).
 */
export type SpaceType = "home" | "team" | "org";
export const SPACE_TYPES: readonly SpaceType[] = ["home", "team", "org"];

/** A space (stored in the `households` table; "household" is the UI word for a home). */
export interface Household {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
  type: SpaceType;
}
/** The general name for a household of any type. */
export type Space = Household;

type HouseholdRow = {
  id: string;
  name: string;
  time_zone: string;
  created_at: number;
  type: SpaceType | null;
};
const toHousehold = (r: HouseholdRow): Household => ({
  id: r.id,
  name: r.name,
  timeZone: r.time_zone,
  createdAt: r.created_at,
  type: r.type ?? "home",
});

/** A membership: one account's role (and name) in one household. */
export interface User {
  id: string;
  householdId: string;
  /** The person's account on this server (shared across their households). */
  accountId: string;
  name: string;
  role: Role;
}

/** A person on this server, addressed as `handle@host`. */
export interface Account {
  id: string;
  handle: string;
  name: string;
  createdAt: number;
  handleChangedAt: number | null;
  /** Shares availability with connections ("Share my availability"). */
  sharePresence: boolean;
  /** Set by an operator: no sign-in, calls or knocks. */
  suspendedAt: number | null;
  /** Not held to the fair-use allowance (set by an operator, e.g. for a venue). */
  fairUseExempt: boolean;
}

/** One account's metered use in one calendar month (UTC). */
export interface Usage {
  month: string;
  callMinutes: number;
  voicemails: number;
  voicemailBytes: number;
  knocks: number;
}

/** One party's record of a finished call. */
export interface CallLogEntry {
  householdId: string;
  accountId: string | null;
  deviceId: string | null;
  /** `handle@host`, `user:<id>` or `device:<id>`. */
  peer: string;
  peerLabel: string;
  direction: "in" | "out";
  startedAt: number;
  answered: boolean;
  durationMs: number;
  endReason: string | null;
  voicemailId?: string | null;
  expiresAt?: number | null;
}

/** 'YYYY-MM' (UTC) for a time. */
export const monthOf = (now: number): string => new Date(now).toISOString().slice(0, 7);

/** When the month containing `now` ends (UTC): the allowance resets then. */
export function monthEnds(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** One of an account's households, with its role there. */
export interface Membership {
  user: User;
  household: Household;
}

/** Handles are unique per server: 2–30 of a-z, 0-9, ".", "_" and "-". */
export const HANDLE_RE = /^[a-z0-9._-]{2,30}$/;
/** Handles that would read as the server itself or its staff. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "root",
  "system",
  "support",
  "help",
  "hub",
  "server",
  "operator",
  "postmaster",
  "abuse",
  "security",
  "openloungephone",
  "noreply",
  "no-reply",
]);

/** Why a handle can't be used, or undefined when it's fine (uniqueness is checked separately). */
export function handleProblem(handle: string): string | undefined {
  if (!HANDLE_RE.test(handle)) {
    return "use 2-30 lower-case letters, digits, dots, dashes or underscores";
  }
  if (RESERVED_HANDLES.has(handle)) return "that handle is reserved";
  return undefined;
}

/** A handle suggestion from a display name ("José Díaz" → "jose.diaz"). */
export function handleFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24)
    .replace(/\.+$/, "");
  return slug.length >= 2 && !RESERVED_HANDLES.has(slug) ? slug : "user";
}

/** Minimum time between two handle changes. */
export const HANDLE_CHANGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A released handle stays reserved (for its last owner only) this long. */
export const HANDLE_RESERVE_MS = 90 * 24 * 60 * 60 * 1000;

export type KeyAlg = "ed25519" | "p256";
export type PhoneKind = "kids" | "lounge";

/** A takeover of a Lounge phone; `endedAt` is null while it lasts. */
export interface LoungeSessionRecord {
  id: string;
  deviceId: string;
  /** The member using the phone; null for a guest from another server. */
  userId: string | null;
  /** A guest from another server: `handle@host` and name. */
  guest: { address: string; name: string } | null;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  openToChat: boolean;
  /** Set while the phone is disconnected (the session may still resume). */
  offlineAt: number | null;
}

type LoungeSessionRow = {
  id: string;
  device_id: string;
  user_id: string | null;
  guest_address?: string | null;
  guest_name?: string | null;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  open_to_chat: number;
  offline_at: number | null;
};
const toLoungeSession = (r: LoungeSessionRow): LoungeSessionRecord => ({
  id: r.id,
  deviceId: r.device_id,
  userId: r.user_id,
  guest: r.guest_address ? { address: r.guest_address, name: r.guest_name ?? "" } : null,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  openToChat: r.open_to_chat === 1,
  offlineAt: r.offline_at,
});

export const DEFAULT_LOUNGE_IDLE_MINUTES = 10;

export interface Device {
  id: string;
  householdId: string;
  name: string;
  publicKey: string;
  keyAlg: KeyAlg;
  /** Set for a person's own phone; null for a household phone (e.g. a kid's). */
  ownerUserId: string | null;
  /** `lounge` = a shared phone people take over; never owned by one person. */
  kind: PhoneKind;
  createdAt: number;
  lastSeen: number | null;
}

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface Invite {
  householdId: string;
  /** Set for sign-in links for an existing person. */
  userId: string | null;
  name: string;
  role: Role;
  expiresAt: number;
}

export interface Passkey {
  id: string;
  accountId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export type TranscriptStatus = "pending" | "done" | "failed" | "unavailable";

export interface Voicemail {
  id: string;
  householdId: string;
  deviceId: string;
  fromUser: string | null;
  fromLabel: string;
  createdAt: number;
  durationMs: number;
  mime: string;
  blobKey: string;
  transcript: string | null;
  transcriptStatus: TranscriptStatus;
  heardAt: number | null;
}

type VoicemailRow = {
  id: string;
  household_id: string;
  device_id: string;
  from_user: string | null;
  from_label: string;
  created_at: number;
  duration_ms: number;
  mime: string;
  blob_key: string;
  transcript: string | null;
  transcript_status: TranscriptStatus;
  heard_at: number | null;
};
const toVoicemail = (r: VoicemailRow): Voicemail => ({
  id: r.id,
  householdId: r.household_id,
  deviceId: r.device_id,
  fromUser: r.from_user,
  fromLabel: r.from_label,
  createdAt: r.created_at,
  durationMs: r.duration_ms,
  mime: r.mime,
  blobKey: r.blob_key,
  transcript: r.transcript,
  transcriptStatus: r.transcript_status,
  heardAt: r.heard_at,
});

type PasskeyRow = {
  id: string;
  account_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
};
const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  accountId: r.account_id,
  publicKey: r.public_key,
  counter: r.counter,
  transports: JSON.parse(r.transports) as string[],
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

type DeviceRow = {
  id: string;
  household_id: string;
  name: string;
  public_key: string;
  key_alg: KeyAlg;
  owner_user_id: string | null;
  kind: PhoneKind;
  created_at: number;
  last_seen: number | null;
};
type UserRow = {
  id: string;
  household_id: string;
  account_id: string;
  name: string;
  role: Role;
};
type AccountRow = {
  id: string;
  handle: string;
  name: string;
  created_at: number;
  handle_changed_at: number | null;
  share_presence?: number;
  suspended_at?: number | null;
  fair_use_exempt?: number;
};
const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  createdAt: r.created_at,
  handleChangedAt: r.handle_changed_at,
  sharePresence: r.share_presence === 1,
  suspendedAt: r.suspended_at ?? null,
  fairUseExempt: r.fair_use_exempt === 1,
});
type ContactRow = {
  user_id: string;
  label: string;
  can_call_device: number;
  device_can_call: number;
  bypass_quiet_hours: number;
};

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  householdId: r.household_id,
  name: r.name,
  publicKey: r.public_key,
  keyAlg: r.key_alg,
  ownerUserId: r.owner_user_id,
  kind: r.kind ?? "kids",
  createdAt: r.created_at,
  lastSeen: r.last_seen,
});
const toUser = (r: UserRow): User => ({
  id: r.id,
  householdId: r.household_id,
  accountId: r.account_id,
  name: r.name,
  role: r.role,
});
const toContact = (r: ContactRow): Contact => ({
  id: r.user_id,
  label: r.label,
  canCallDevice: r.can_call_device === 1,
  deviceCanCall: r.device_can_call === 1,
  bypassQuietHours: r.bypass_quiet_hours === 1,
});

/** A person from another household or server on a phone's allow-list (via a connection). */
export interface RemoteContact extends Contact {
  /** `rc_…` */
  id: string;
  connectionId: string;
  connection: Connection;
}

/** Remote allow-list entries have ids with this prefix; local ones are user ids. */
export const isRemoteContactId = (id: string) => id.startsWith("rc_");

type RemoteContactRow = ContactRow & { id: string; connection_id: string };

/** Typed data access shared by every backend. All times are epoch ms supplied by the caller. */
export class Store {
  private readonly sql: Sql;
  /** Connections, knocks, server keys and rate limits. */
  readonly connections: ConnectionStore;

  constructor(sql: Sql) {
    this.sql = sql;
    this.connections = new ConnectionStore(sql);
  }

  // --- settings -----------------------------------------------------------

  async getSetting(key: string): Promise<string | undefined> {
    const row = await this.sql.first<{ value: string }>(
      "SELECT value FROM settings WHERE key = ?",
      key,
    );
    return row?.value;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) await this.sql.run("DELETE FROM settings WHERE key = ?", key);
    else {
      await this.sql.run(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
    }
  }

  // --- accounts -------------------------------------------------------------

  /**
   * Creates an account. With no handle, one is derived from the name and made unique ("mom",
   * "mom-2", ...). An explicit handle that is taken returns undefined.
   */
  async createAccount(
    input: { name: string; handle?: string },
    now: number,
  ): Promise<Account | undefined> {
    const id = newId("acc");
    const candidates = input.handle ? [input.handle] : this.handleCandidates(input.name);
    for (const handle of candidates) {
      // Handles released in the last 90 days are reserved for whoever released them.
      const { changes } = await this.sql.run(
        `INSERT OR IGNORE INTO accounts (id, handle, name, created_at)
         SELECT ?, ?, ?, ? WHERE NOT EXISTS
           (SELECT 1 FROM released_handles WHERE handle = ? AND released_at > ?)`,
        id,
        handle,
        input.name,
        now,
        handle,
        now - HANDLE_RESERVE_MS,
      );
      if (changes === 1) {
        return {
          id,
          handle,
          name: input.name,
          createdAt: now,
          handleChangedAt: null,
          sharePresence: false,
          suspendedAt: null,
          fairUseExempt: false,
        };
      }
    }
    return undefined;
  }

  private *handleCandidates(name: string): Generator<string> {
    const base = handleFromName(name);
    yield base;
    for (let n = 2; n < 10; n++) yield `${base}-${n}`;
    for (;;) yield `${base}-${newPairingCode()}`;
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const r = await this.sql.first<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
    return r && toAccount(r);
  }

  async accountByHandle(handle: string): Promise<Account | undefined> {
    const r = await this.sql.first<AccountRow>(
      "SELECT * FROM accounts WHERE handle = ?",
      handle.toLowerCase(),
    );
    return r && toAccount(r);
  }

  /**
   * Whether `handle` can be taken now: nobody has it, and it isn't reserved for someone else
   * (released in the last 90 days by another account).
   */
  async handleAvailable(handle: string, now: number, accountId?: string): Promise<boolean> {
    const r = await this.sql.first<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM accounts WHERE handle = ?) +
              (SELECT COUNT(*) FROM released_handles
               WHERE handle = ? AND released_at > ? AND account_id != ?) AS n`,
      handle,
      handle,
      now - HANDLE_RESERVE_MS,
      accountId ?? "",
    );
    return (r?.n ?? 0) === 0;
  }

  /**
   * Changes a handle. Validate with `handleProblem` first. False when it's taken or reserved.
   * The old handle is then reserved for this account for 90 days.
   */
  async setHandle(accountId: string, handle: string, now: number): Promise<boolean> {
    const before = await this.getAccount(accountId);
    if (!before) return false;
    try {
      const { changes } = await this.sql.run(
        `UPDATE accounts SET handle = ?, handle_changed_at = ? WHERE id = ? AND NOT EXISTS
           (SELECT 1 FROM released_handles
            WHERE handle = ? AND released_at > ? AND account_id != ?)`,
        handle,
        now,
        accountId,
        handle,
        now - HANDLE_RESERVE_MS,
        accountId,
      );
      if (changes !== 1) return false;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return false;
      throw e;
    }
    await this.sql.batch([
      {
        query: "DELETE FROM released_handles WHERE handle = ? OR released_at <= ?",
        params: [handle, now - HANDLE_RESERVE_MS],
      },
      {
        query:
          "INSERT OR REPLACE INTO released_handles (handle, account_id, released_at) VALUES (?, ?, ?)",
        params: [before.handle, accountId, now],
      },
      // Other people on this server see the new address in their connections.
      {
        query: "UPDATE connections SET peer_handle = ? WHERE peer_host = '' AND peer_account = ?",
        params: [handle, accountId],
      },
    ]);
    return true;
  }

  // --- hub: usage, suspension, exemption ------------------------------------------------

  async usage(accountId: string, now: number): Promise<Usage> {
    const month = monthOf(now);
    const r = await this.sql.first<{
      call_minutes: number;
      voicemails: number;
      voicemail_bytes: number;
      knocks: number;
    }>("SELECT * FROM usage WHERE account_id = ? AND month = ?", accountId, month);
    return {
      month,
      callMinutes: r?.call_minutes ?? 0,
      voicemails: r?.voicemails ?? 0,
      voicemailBytes: r?.voicemail_bytes ?? 0,
      knocks: r?.knocks ?? 0,
    };
  }

  /** Adds to this month's metered use. */
  async addUsage(
    accountId: string,
    now: number,
    add: Partial<Omit<Usage, "month">>,
  ): Promise<void> {
    await this.sql.run(
      `INSERT INTO usage (account_id, month, call_minutes, voicemails, voicemail_bytes, knocks)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, month) DO UPDATE SET
         call_minutes = call_minutes + excluded.call_minutes,
         voicemails = voicemails + excluded.voicemails,
         voicemail_bytes = voicemail_bytes + excluded.voicemail_bytes,
         knocks = knocks + excluded.knocks`,
      accountId,
      monthOf(now),
      add.callMinutes ?? 0,
      add.voicemails ?? 0,
      add.voicemailBytes ?? 0,
      add.knocks ?? 0,
    );
  }

  async setSuspended(accountId: string, at: number | null): Promise<void> {
    await this.sql.run("UPDATE accounts SET suspended_at = ? WHERE id = ?", at, accountId);
  }

  async setFairUseExempt(accountId: string, exempt: boolean): Promise<void> {
    await this.sql.run(
      "UPDATE accounts SET fair_use_exempt = ? WHERE id = ?",
      exempt ? 1 : 0,
      accountId,
    );
  }

  /** Records one party's view of a finished call (see migration 0010). */
  async logCall(entry: CallLogEntry): Promise<string> {
    const id = newId("cl");
    await this.sql.run(
      `INSERT INTO call_log (id, household_id, account_id, device_id, peer, peer_label, direction,
         started_at, answered, duration_ms, end_reason, voicemail_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.householdId,
      entry.accountId,
      entry.deviceId,
      entry.peer,
      entry.peerLabel,
      entry.direction,
      entry.startedAt,
      entry.answered ? 1 : 0,
      entry.durationMs,
      entry.endReason,
      entry.voicemailId ?? null,
      entry.expiresAt ?? null,
    );
    return id;
  }

  /** An account's calls with one peer (newest first), or all of its calls. */
  async callLog(accountId: string, peer?: string, limit = 100): Promise<CallLogEntry[]> {
    const rows = await this.sql.all<{
      household_id: string;
      account_id: string | null;
      device_id: string | null;
      peer: string;
      peer_label: string;
      direction: "in" | "out";
      started_at: number;
      answered: number;
      duration_ms: number;
      end_reason: string | null;
      voicemail_id: string | null;
      expires_at: number | null;
    }>(
      `SELECT * FROM call_log WHERE account_id = ? ${peer ? "AND peer = ?" : ""}
       ORDER BY started_at DESC LIMIT ?`,
      ...(peer ? [accountId, peer, limit] : [accountId, limit]),
    );
    return rows.map((r) => ({
      householdId: r.household_id,
      accountId: r.account_id,
      deviceId: r.device_id,
      peer: r.peer,
      peerLabel: r.peer_label,
      direction: r.direction,
      startedAt: r.started_at,
      answered: r.answered === 1,
      durationMs: r.duration_ms,
      endReason: r.end_reason,
      voicemailId: r.voicemail_id,
      expiresAt: r.expires_at,
    }));
  }

  /** Deletes a space and everything in it (members, phones, voicemail rows, logs). */
  async deleteHousehold(id: string): Promise<void> {
    await this.sql.run("DELETE FROM households WHERE id = ?", id);
  }

  /** Deletes an account (sessions, passkeys, connections, usage go with it); its handle is reserved. */
  async deleteAccount(id: string, now: number): Promise<void> {
    await this.sql.batch([
      {
        query: `INSERT OR REPLACE INTO released_handles (handle, account_id, released_at)
          SELECT handle, id, ? FROM accounts WHERE id = ?`,
        params: [now, id],
      },
      { query: "DELETE FROM users WHERE account_id = ?", params: [id] },
      { query: "DELETE FROM accounts WHERE id = ?", params: [id] },
    ]);
  }

  /** How many guardians a space has. */
  async guardianCount(householdId: string): Promise<number> {
    const r = await this.sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND role = 'guardian'",
      householdId,
    );
    return r?.n ?? 0;
  }

  /** The account that answers for a space: its first guardian. */
  async spaceOwner(householdId: string): Promise<string | undefined> {
    const r = await this.sql.first<{ account_id: string }>(
      `SELECT account_id FROM users WHERE household_id = ? AND role = 'guardian'
       ORDER BY created_at, rowid LIMIT 1`,
      householdId,
    );
    return r?.account_id;
  }

  /** Counts for the operator's overview. */
  async hubCounts(): Promise<Record<string, number>> {
    const r = await this.sql.first<Record<string, number>>(
      `SELECT (SELECT COUNT(*) FROM accounts) AS accounts,
         (SELECT COUNT(*) FROM households) AS spaces,
         (SELECT COUNT(*) FROM devices) AS phones,
         (SELECT COUNT(*) FROM accounts WHERE suspended_at IS NOT NULL) AS suspended,
         (SELECT COUNT(*) FROM accounts WHERE fair_use_exempt = 1) AS exempt,
         (SELECT COUNT(*) FROM connections WHERE state = 'active') AS connections`,
    );
    return r ?? {};
  }

  async setSharePresence(accountId: string, share: boolean): Promise<void> {
    await this.sql.run(
      "UPDATE accounts SET share_presence = ? WHERE id = ?",
      share ? 1 : 0,
      accountId,
    );
  }

  async setAccountName(accountId: string, name: string): Promise<void> {
    await this.sql.run("UPDATE accounts SET name = ? WHERE id = ?", name, accountId);
  }

  /** Every household the account belongs to, oldest membership first. */
  async listMemberships(accountId: string): Promise<Membership[]> {
    const rows = await this.sql.all<
      UserRow & { h_name: string; h_time_zone: string; h_created_at: number; h_type: SpaceType }
    >(
      `SELECT u.id, u.household_id, u.account_id, u.name, u.role,
         h.name AS h_name, h.time_zone AS h_time_zone, h.created_at AS h_created_at,
         h.type AS h_type
       FROM users u JOIN households h ON h.id = u.household_id
       WHERE u.account_id = ? ORDER BY u.created_at, u.rowid`,
      accountId,
    );
    return rows.map((r) => ({
      user: toUser(r),
      household: toHousehold({
        id: r.household_id,
        name: r.h_name,
        time_zone: r.h_time_zone,
        created_at: r.h_created_at,
        type: r.h_type,
      }),
    }));
  }

  /** The account's membership in a household, if it has one. */
  async membership(accountId: string, householdId: string): Promise<User | undefined> {
    const r = await this.sql.first<UserRow>(
      "SELECT * FROM users WHERE account_id = ? AND household_id = ?",
      accountId,
      householdId,
    );
    return r && toUser(r);
  }

  /** Households in which the account is a guardian (for quotas). */
  async countGuardianships(accountId: string): Promise<number> {
    const r = await this.sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM users WHERE account_id = ? AND role = 'guardian'",
      accountId,
    );
    return r?.n ?? 0;
  }

  // --- households & users -------------------------------------------------

  async countHouseholds(): Promise<number> {
    const row = await this.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM households");
    return row?.n ?? 0;
  }

  /**
   * Creates a household with its first guardian. With `accountId` the guardian is that account's
   * new membership; otherwise a new account is created for them.
   */
  async createHousehold(
    input: {
      name: string;
      timeZone: string;
      guardianName: string;
      accountId?: string;
      type?: SpaceType;
    },
    now: number,
  ): Promise<{ household: Household; guardian: User }> {
    const accountId =
      input.accountId ??
      ((await this.createAccount({ name: input.guardianName }, now)) as Account).id;
    const household: Household = {
      id: newId("hh"),
      name: input.name,
      timeZone: input.timeZone,
      createdAt: now,
      type: input.type ?? "home",
    };
    const guardian: User = {
      id: newId("usr"),
      householdId: household.id,
      accountId,
      name: input.guardianName,
      role: "guardian",
    };
    await this.sql.batch([
      {
        query:
          "INSERT INTO households (id, name, time_zone, created_at, type) VALUES (?, ?, ?, ?, ?)",
        params: [household.id, household.name, household.timeZone, now, household.type],
      },
      {
        query:
          "INSERT INTO users (id, household_id, account_id, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [guardian.id, household.id, accountId, guardian.name, guardian.role, now],
      },
    ]);
    return { household, guardian };
  }

  async getHousehold(id: string): Promise<Household | undefined> {
    const r = await this.sql.first<HouseholdRow>("SELECT * FROM households WHERE id = ?", id);
    return r && toHousehold(r);
  }

  /**
   * Adds a person to a household. With `accountId` it's another membership of that account;
   * otherwise a new account is created for them.
   */
  async createUser(
    input: { householdId: string; name: string; role: Role; accountId?: string },
    now: number,
  ): Promise<User> {
    const accountId =
      input.accountId ?? ((await this.createAccount({ name: input.name }, now)) as Account).id;
    const user: User = {
      id: newId("usr"),
      householdId: input.householdId,
      accountId,
      name: input.name,
      role: input.role,
    };
    await this.sql.run(
      "INSERT INTO users (id, household_id, account_id, name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      user.id,
      user.householdId,
      user.accountId,
      user.name,
      user.role,
      now,
    );
    return user;
  }

  async getUser(id: string): Promise<User | undefined> {
    const r = await this.sql.first<UserRow>("SELECT * FROM users WHERE id = ?", id);
    return r && toUser(r);
  }

  async setAvailable(userId: string, available: boolean): Promise<void> {
    await this.sql.run("UPDATE users SET available = ? WHERE id = ?", available ? 1 : 0, userId);
  }

  /** Availability of every member of a household, by user id. */
  async availability(householdId: string): Promise<Map<string, boolean>> {
    const rows = await this.sql.all<{ id: string; available: number }>(
      "SELECT id, available FROM users WHERE household_id = ?",
      householdId,
    );
    return new Map(rows.map((r) => [r.id, r.available === 1]));
  }

  /**
   * Removes a person from a household; their allow-list entries and keys there go with it. An
   * account left with no household at all is deleted with its sessions and passkeys.
   */
  async deleteUser(id: string, now: number): Promise<void> {
    const user = await this.getUser(id);
    if (!user) return;
    await this.sql.batch([
      { query: "DELETE FROM users WHERE id = ?", params: [id] },
      // A deleted account's handle stays reserved for 90 days.
      {
        query: `INSERT OR REPLACE INTO released_handles (handle, account_id, released_at)
          SELECT handle, id, ? FROM accounts
          WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE account_id = ?)`,
        params: [now, user.accountId, user.accountId],
      },
      {
        query:
          "DELETE FROM accounts WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE account_id = ?)",
        params: [user.accountId, user.accountId],
      },
    ]);
  }

  async listUsers(householdId: string): Promise<User[]> {
    const rows = await this.sql.all<UserRow>(
      "SELECT * FROM users WHERE household_id = ? ORDER BY created_at",
      householdId,
    );
    return rows.map(toUser);
  }

  // --- sessions -----------------------------------------------------------

  /** Signs in the membership's account with that household active. Returns the bearer token. */
  async createSession(userId: string, now: number): Promise<string> {
    const user = await this.getUser(userId);
    if (!user) throw new Error(`unknown user ${userId}`);
    return this.createAccountSession(user.accountId, user.id, now);
  }

  /** Returns the bearer token; only its hash is stored. `userId` is the active membership. */
  async createAccountSession(
    accountId: string,
    userId: string | null,
    now: number,
  ): Promise<string> {
    const token = newToken();
    await this.sql.run(
      "INSERT INTO sessions (token_hash, account_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      await sha256(token),
      accountId,
      userId,
      now,
      now + SESSION_TTL_MS,
    );
    return token;
  }

  /**
   * Resolves a session: its account and active membership. When the active membership is gone
   * (removed from that household), the account's oldest remaining membership becomes active;
   * `user` is undefined only for an account that belongs to no household.
   */
  async sessionForToken(
    token: string,
    now: number,
  ): Promise<{ account: Account; user: User | undefined } | undefined> {
    const hash = await sha256(token);
    const s = await this.sql.first<{ account_id: string; user_id: string | null }>(
      "SELECT account_id, user_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
      hash,
      now,
    );
    if (!s) return undefined;
    const account = await this.getAccount(s.account_id);
    if (!account) return undefined;
    let user = s.user_id ? await this.getUser(s.user_id) : undefined;
    if (!user || user.accountId !== account.id) {
      user = (await this.listMemberships(account.id))[0]?.user;
      if (user) {
        await this.sql.run("UPDATE sessions SET user_id = ? WHERE token_hash = ?", user.id, hash);
      }
    }
    return { account, user };
  }

  /** The session's active membership (see `sessionForToken`). */
  async userForToken(token: string, now: number): Promise<User | undefined> {
    return (await this.sessionForToken(token, now))?.user;
  }

  /** Makes another of the session's own memberships active. */
  async setSessionUser(token: string, userId: string): Promise<void> {
    await this.sql.run(
      `UPDATE sessions SET user_id = ? WHERE token_hash = ?
       AND account_id = (SELECT account_id FROM users WHERE id = ?)`,
      userId,
      await sha256(token),
      userId,
    );
  }

  async deleteSession(token: string): Promise<void> {
    await this.sql.run("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
  }

  // --- devices & pairing --------------------------------------------------

  /** Registers a pending pairing and returns its code. Replaces any earlier code for the key. */
  async createPairing(
    publicKey: string,
    now: number,
    keyAlg: KeyAlg = "ed25519",
    kind?: PhoneKind,
  ): Promise<{ code: string; expiresAt: number }> {
    await this.sql.run(
      "DELETE FROM pairings WHERE expires_at <= ? OR public_key = ?",
      now,
      publicKey,
    );
    const expiresAt = now + PAIRING_TTL_MS;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newPairingCode();
      const { changes } = await this.sql.run(
        "INSERT OR IGNORE INTO pairings (code, public_key, expires_at, key_alg, kind) VALUES (?, ?, ?, ?, ?)",
        code,
        publicKey,
        expiresAt,
        keyAlg,
        kind ?? null,
      );
      if (changes === 1) return { code, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  /** Claims a pairing code for a household, creating the device. Single use. */
  async claimPairing(
    input: {
      code: string;
      householdId: string;
      name: string;
      ownerUserId?: string | null;
      /** Overrides the kind the phone asked for. */
      kind?: PhoneKind;
    },
    now: number,
  ): Promise<Device | undefined> {
    const pending = await this.sql.first<{
      public_key: string;
      key_alg: KeyAlg;
      kind: PhoneKind | null;
    }>(
      "SELECT public_key, key_alg, kind FROM pairings WHERE code = ? AND expires_at > ?",
      input.code,
      now,
    );
    if (!pending) return undefined;
    const { changes } = await this.sql.run("DELETE FROM pairings WHERE code = ?", input.code);
    if (changes !== 1) return undefined; // claimed concurrently
    const device: Device = {
      id: newId("dev"),
      householdId: input.householdId,
      name: input.name,
      publicKey: pending.public_key,
      keyAlg: pending.key_alg,
      ownerUserId: input.ownerUserId ?? null,
      kind: input.kind ?? pending.kind ?? "kids",
      createdAt: now,
      lastSeen: null,
    };
    // A key re-paired to a new household replaces its old device record.
    await this.sql.batch([
      { query: "DELETE FROM devices WHERE public_key = ?", params: [device.publicKey] },
      {
        query:
          "INSERT INTO devices (id, household_id, name, public_key, key_alg, owner_user_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          device.id,
          device.householdId,
          device.name,
          device.publicKey,
          device.keyAlg,
          device.ownerUserId,
          device.kind,
          now,
        ],
      },
    ]);
    return device;
  }

  async getDevice(id: string): Promise<Device | undefined> {
    const r = await this.sql.first<DeviceRow>("SELECT * FROM devices WHERE id = ?", id);
    return r && toDevice(r);
  }

  async listDevices(householdId: string): Promise<Device[]> {
    const rows = await this.sql.all<DeviceRow>(
      "SELECT * FROM devices WHERE household_id = ? ORDER BY created_at",
      householdId,
    );
    return rows.map(toDevice);
  }

  async updateDevice(
    id: string,
    changes: { name?: string; ownerUserId?: string | null },
  ): Promise<void> {
    if (changes.name !== undefined) {
      await this.sql.run("UPDATE devices SET name = ? WHERE id = ?", changes.name, id);
    }
    if (changes.ownerUserId !== undefined) {
      await this.sql.run(
        "UPDATE devices SET owner_user_id = ? WHERE id = ?",
        changes.ownerUserId,
        id,
      );
    }
  }

  /** Removes a phone; its allow-list, keys and voicemail go with it. */
  async deleteDevice(id: string): Promise<void> {
    await this.sql.run("DELETE FROM devices WHERE id = ?", id);
  }

  async touchDevice(id: string, now: number): Promise<void> {
    await this.sql.run("UPDATE devices SET last_seen = ? WHERE id = ?", now, id);
  }

  // --- allow-list & buttons -----------------------------------------------

  async upsertContact(deviceId: string, contact: Contact): Promise<void> {
    await this.sql.run(
      `INSERT INTO contacts (device_id, user_id, label, can_call_device, device_can_call, bypass_quiet_hours)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, user_id) DO UPDATE SET label = excluded.label,
         can_call_device = excluded.can_call_device, device_can_call = excluded.device_can_call,
         bypass_quiet_hours = excluded.bypass_quiet_hours`,
      deviceId,
      contact.id,
      contact.label,
      contact.canCallDevice ? 1 : 0,
      contact.deviceCanCall ? 1 : 0,
      contact.bypassQuietHours ? 1 : 0,
    );
  }

  async removeContact(deviceId: string, userId: string): Promise<void> {
    if (isRemoteContactId(userId)) {
      await this.sql.run(
        "DELETE FROM remote_contacts WHERE device_id = ? AND id = ?",
        deviceId,
        userId,
      );
      return;
    }
    await this.sql.batch([
      {
        query: "DELETE FROM contacts WHERE device_id = ? AND user_id = ?",
        params: [deviceId, userId],
      },
      {
        query: "DELETE FROM buttons WHERE device_id = ? AND user_id = ?",
        params: [deviceId, userId],
      },
    ]);
  }

  async getContact(deviceId: string, userId: string): Promise<Contact | undefined> {
    if (isRemoteContactId(userId)) {
      return (await this.listRemoteContacts(deviceId)).find((c) => c.id === userId);
    }
    const r = await this.sql.first<ContactRow>(
      "SELECT * FROM contacts WHERE device_id = ? AND user_id = ?",
      deviceId,
      userId,
    );
    return r && toContact(r);
  }

  /** The whole allow-list: household members, then people via connections (`rc_…` ids). */
  async listContacts(deviceId: string): Promise<Contact[]> {
    const rows = await this.sql.all<ContactRow>(
      "SELECT * FROM contacts WHERE device_id = ? ORDER BY label",
      deviceId,
    );
    const remote = (await this.listRemoteContacts(deviceId)).map(
      ({ connection: _c, connectionId: _i, ...c }) => c,
    );
    return [...rows.map(toContact), ...remote];
  }

  /** People from other households or servers on a phone's allow-list (active connections only). */
  async listRemoteContacts(deviceId: string): Promise<RemoteContact[]> {
    const rows = await this.sql.all<RemoteContactRow & { c_id: string }>(
      `SELECT r.id, r.connection_id, r.label, r.can_call_device, r.device_can_call,
         r.bypass_quiet_hours, r.id AS user_id, c.id AS c_id
       FROM remote_contacts r JOIN connections c ON c.id = r.connection_id
       WHERE r.device_id = ? AND c.state = 'active' ORDER BY r.label`,
      deviceId,
    );
    const out: RemoteContact[] = [];
    for (const r of rows) {
      const connection = await this.connections.get(r.connection_id);
      if (!connection) continue;
      out.push({ ...toContact(r), id: r.id, connectionId: r.connection_id, connection });
    }
    return out;
  }

  /** Adds (or updates) a connection on a phone's allow-list; returns its `rc_…` id. */
  async upsertRemoteContact(
    deviceId: string,
    connectionId: string,
    c: Omit<Contact, "id">,
  ): Promise<string> {
    await this.sql.run(
      `INSERT INTO remote_contacts (id, device_id, connection_id, label, can_call_device,
         device_can_call, bypass_quiet_hours) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, connection_id) DO UPDATE SET label = excluded.label,
         can_call_device = excluded.can_call_device, device_can_call = excluded.device_can_call,
         bypass_quiet_hours = excluded.bypass_quiet_hours`,
      newId("rc"),
      deviceId,
      connectionId,
      c.label,
      c.canCallDevice ? 1 : 0,
      c.deviceCanCall ? 1 : 0,
      c.bypassQuietHours ? 1 : 0,
    );
    const r = await this.sql.first<{ id: string }>(
      "SELECT id FROM remote_contacts WHERE device_id = ? AND connection_id = ?",
      deviceId,
      connectionId,
    );
    return (r as { id: string }).id;
  }

  /** This side's phones whose allow-list lets this connection's person call them. */
  async sharedPhones(connectionId: string): Promise<{ id: string; label: string }[]> {
    const rows = await this.sql.all<{ id: string; name: string }>(
      `SELECT d.id, d.name FROM remote_contacts r JOIN devices d ON d.id = r.device_id
       WHERE r.connection_id = ? AND r.can_call_device = 1 ORDER BY d.name`,
      connectionId,
    );
    return rows.map((r) => ({ id: r.id, label: r.name.slice(0, 24) }));
  }

  /** Phones on the other side that a connection shares with its owner. */
  connectionPhones(connectionId: string) {
    return this.connections.phones(connectionId);
  }

  /** Phones (with their allow-list entry) that list this connection. */
  async phonesForConnection(connectionId: string): Promise<{ deviceId: string; id: string }[]> {
    const rows = await this.sql.all<{ device_id: string; id: string }>(
      "SELECT device_id, id FROM remote_contacts WHERE connection_id = ?",
      connectionId,
    );
    return rows.map((r) => ({ deviceId: r.device_id, id: r.id }));
  }

  /** Maps a key to a person on the allow-list (a user id or an `rc_…` id), or clears it. */
  async setButton(deviceId: string, index: number, userId: string | null): Promise<void> {
    await this.sql.run(
      "DELETE FROM remote_buttons WHERE device_id = ? AND idx = ?",
      deviceId,
      index,
    );
    if (userId === null) {
      await this.sql.run("DELETE FROM buttons WHERE device_id = ? AND idx = ?", deviceId, index);
    } else if (isRemoteContactId(userId)) {
      await this.sql.batch([
        { query: "DELETE FROM buttons WHERE device_id = ? AND idx = ?", params: [deviceId, index] },
        {
          query: "INSERT INTO remote_buttons (device_id, idx, remote_id) VALUES (?, ?, ?)",
          params: [deviceId, index, userId],
        },
      ]);
    } else {
      await this.sql.run(
        `INSERT INTO buttons (device_id, idx, user_id) VALUES (?, ?, ?)
         ON CONFLICT(device_id, idx) DO UPDATE SET user_id = excluded.user_id`,
        deviceId,
        index,
        userId,
      );
    }
  }

  async listButtons(deviceId: string): Promise<ButtonMap> {
    const rows = await this.sql.all<{ idx: number; user_id: string }>(
      `SELECT idx, user_id FROM buttons WHERE device_id = ?
       UNION ALL SELECT idx, remote_id AS user_id FROM remote_buttons WHERE device_id = ?
       ORDER BY idx`,
      deviceId,
      deviceId,
    );
    return new Map(rows.map((r) => [r.idx, r.user_id]));
  }

  // --- quiet hours ----------------------------------------------------------

  async getSchedule(householdId: string): Promise<QuietHoursSchedule> {
    const household = await this.getHousehold(householdId);
    if (!household) throw new Error(`unknown household ${householdId}`);
    const rows = await this.sql.all<{ days: string; start_time: string; end_time: string }>(
      "SELECT days, start_time, end_time FROM quiet_rules WHERE household_id = ? ORDER BY id",
      householdId,
    );
    return {
      timeZone: household.timeZone,
      // Quiet hours are a kid-safety rule: only home spaces have them.
      rules: (household.type === "home" ? rows : []).map((r) => ({
        days: JSON.parse(r.days) as Weekday[],
        start: r.start_time,
        end: r.end_time,
      })),
    };
  }

  /** Replaces all quiet-hours rules. Validate with `validateSchedule` before calling. */
  async setQuietRules(householdId: string, rules: QuietHoursRule[]): Promise<void> {
    await this.sql.batch([
      { query: "DELETE FROM quiet_rules WHERE household_id = ?", params: [householdId] },
      ...rules.map((r) => ({
        query:
          "INSERT INTO quiet_rules (id, household_id, days, start_time, end_time) VALUES (?, ?, ?, ?, ?)",
        params: [newId("qr"), householdId, JSON.stringify(r.days), r.start, r.end],
      })),
    ]);
  }
  // --- lounge ---------------------------------------------------------------

  async loungeIdleMinutes(householdId: string): Promise<number> {
    const r = await this.sql.first<{ m: number }>(
      "SELECT lounge_idle_minutes AS m FROM households WHERE id = ?",
      householdId,
    );
    return r?.m ?? DEFAULT_LOUNGE_IDLE_MINUTES;
  }

  async setLoungeIdleMinutes(householdId: string, minutes: number): Promise<void> {
    await this.sql.run(
      "UPDATE households SET lounge_idle_minutes = ? WHERE id = ?",
      minutes,
      householdId,
    );
  }

  /** Records that a session started (who, where, when) and returns its id. */
  /** Records that a session started (a member, or a guest from another server). */
  async startLoungeSession(
    input: {
      householdId: string;
      deviceId: string;
      userId?: string;
      guest?: { address: string; name: string };
    },
    now: number,
  ): Promise<string> {
    const id = newId("ls");
    await this.sql.run(
      `INSERT INTO lounge_sessions (id, household_id, device_id, user_id, guest_address,
         guest_name, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.householdId,
      input.deviceId,
      input.userId ?? null,
      input.guest?.address ?? null,
      input.guest?.name ?? null,
      now,
    );
    return id;
  }

  /** Whether people from other servers may use this space's Lounge phones. */
  async loungeGuests(householdId: string): Promise<boolean> {
    const r = await this.sql.first<{ g: number }>(
      "SELECT lounge_guests AS g FROM households WHERE id = ?",
      householdId,
    );
    return r?.g === 1;
  }

  async setLoungeGuests(householdId: string, allowed: boolean): Promise<void> {
    await this.sql.run(
      "UPDATE households SET lounge_guests = ? WHERE id = ?",
      allowed ? 1 : 0,
      householdId,
    );
  }

  // --- this server's accounts as guests elsewhere ----------------------------------------

  /** Records a claim of another server's Lounge phone (pending until the key press). */
  async startLoungeAway(accountId: string, host: string, deviceId: string, now: number) {
    await this.sql.run(
      `INSERT INTO lounge_away (id, account_id, host, device_id, state, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(account_id, host, device_id) DO UPDATE SET state = 'pending',
         created_at = excluded.created_at, ended_at = NULL`,
      newId("la"),
      accountId,
      host,
      deviceId,
      now,
    );
  }

  async setLoungeAway(
    accountId: string,
    host: string,
    deviceId: string,
    state: "active" | "ended",
    now: number,
  ): Promise<void> {
    await this.sql.run(
      `UPDATE lounge_away SET state = ?, ended_at = CASE WHEN ? = 'ended' THEN ? ELSE NULL END
       WHERE account_id = ? AND host = ? AND device_id = ? AND state != 'ended'`,
      state,
      state,
      now,
      accountId,
      host,
      deviceId,
    );
  }

  async loungeAwayState(
    accountId: string,
    host: string,
    deviceId: string,
  ): Promise<"pending" | "active" | "ended" | undefined> {
    const r = await this.sql.first<{ state: "pending" | "active" | "ended" }>(
      "SELECT state FROM lounge_away WHERE account_id = ? AND host = ? AND device_id = ?",
      accountId,
      host,
      deviceId,
    );
    return r?.state;
  }

  async endLoungeSession(id: string, reason: string, now: number): Promise<void> {
    await this.sql.run(
      "UPDATE lounge_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
      now,
      reason,
      id,
    );
  }

  /** The session still open on a phone (at most one), e.g. to resume after a reconnect. */
  async openLoungeSession(deviceId: string): Promise<LoungeSessionRecord | undefined> {
    const r = await this.sql.first<LoungeSessionRow>(
      "SELECT * FROM lounge_sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY started_at DESC",
      deviceId,
    );
    return r && toLoungeSession(r);
  }

  /** Open sessions whose phone is disconnected, in a household (oldest disconnect first). */
  async offlineLoungeSessions(householdId: string): Promise<LoungeSessionRecord[]> {
    const rows = await this.sql.all<LoungeSessionRow>(
      `SELECT * FROM lounge_sessions WHERE household_id = ? AND ended_at IS NULL
       AND offline_at IS NOT NULL ORDER BY offline_at`,
      householdId,
    );
    return rows.map(toLoungeSession);
  }

  async setLoungeOffline(id: string, at: number | null): Promise<void> {
    await this.sql.run("UPDATE lounge_sessions SET offline_at = ? WHERE id = ?", at, id);
  }

  async setLoungeChat(id: string, open: boolean): Promise<void> {
    await this.sql.run(
      "UPDATE lounge_sessions SET open_to_chat = ? WHERE id = ?",
      open ? 1 : 0,
      id,
    );
  }

  /** Newest first; open sessions have `endedAt` null. */
  async listLoungeSessions(householdId: string, limit = 50): Promise<LoungeSessionRecord[]> {
    const rows = await this.sql.all<LoungeSessionRow>(
      "SELECT * FROM lounge_sessions WHERE household_id = ? ORDER BY started_at DESC LIMIT ?",
      householdId,
      limit,
    );
    return rows.map(toLoungeSession);
  }

  // --- invites --------------------------------------------------------------

  /** Returns the invite token; only its hash is stored. */
  async createInvite(
    input: { householdId: string; userId?: string; name: string; role: Role; createdBy: string },
    now: number,
  ): Promise<{ token: string; expiresAt: number }> {
    const token = newToken();
    const expiresAt = now + INVITE_TTL_MS;
    await this.sql.run(
      `INSERT INTO invites (token_hash, household_id, user_id, name, role, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      await sha256(token),
      input.householdId,
      input.userId ?? null,
      input.name,
      input.role,
      input.createdBy,
      now,
      expiresAt,
    );
    return { token, expiresAt };
  }

  async peekInvite(token: string, now: number): Promise<Invite | undefined> {
    const r = await this.sql.first<{
      household_id: string;
      user_id: string | null;
      name: string;
      role: Role;
      expires_at: number;
    }>("SELECT * FROM invites WHERE token_hash = ? AND expires_at > ?", await sha256(token), now);
    return (
      r && {
        householdId: r.household_id,
        userId: r.user_id,
        name: r.name,
        role: r.role,
        expiresAt: r.expires_at,
      }
    );
  }

  /**
   * Consumes an invite (single use) and returns the membership it signs in. A sign-in link
   * returns its existing person; otherwise a new membership is created, for `accountId` when the
   * person accepting is already signed in, else for a new account.
   */
  async acceptInvite(token: string, now: number, accountId?: string): Promise<User | undefined> {
    const invite = await this.peekInvite(token, now);
    if (!invite) return undefined;
    const { changes } = await this.sql.run(
      "DELETE FROM invites WHERE token_hash = ?",
      await sha256(token),
    );
    if (changes !== 1) return undefined; // accepted concurrently
    if (invite.userId) return this.getUser(invite.userId);
    return this.createUser(
      {
        householdId: invite.householdId,
        name: invite.name,
        role: invite.role,
        ...(accountId ? { accountId } : {}),
      },
      now,
    );
  }

  // --- passkeys ---------------------------------------------------------------

  async saveChallenge(
    input: {
      kind: "register" | "login" | "signup";
      challenge: string;
      accountId?: string;
      /** Small JSON-able payload kept until the challenge is taken (sign-up details). */
      data?: unknown;
    },
    now: number,
  ): Promise<string> {
    const id = newId("ch");
    await this.sql.batch([
      { query: "DELETE FROM auth_challenges WHERE expires_at <= ?", params: [now] },
      {
        query:
          "INSERT INTO auth_challenges (id, challenge, kind, account_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [
          id,
          input.challenge,
          input.kind,
          input.accountId ?? null,
          input.data === undefined ? null : JSON.stringify(input.data),
          now + CHALLENGE_TTL_MS,
        ],
      },
    ]);
    return id;
  }

  /** Single use: the challenge is deleted whether or not verification later succeeds. */
  async takeChallenge(
    id: string,
    kind: "register" | "login" | "signup",
    now: number,
  ): Promise<{ challenge: string; accountId: string | null; data: unknown } | undefined> {
    const r = await this.sql.first<{
      challenge: string;
      account_id: string | null;
      data: string | null;
    }>(
      "SELECT challenge, account_id, data FROM auth_challenges WHERE id = ? AND kind = ? AND expires_at > ?",
      id,
      kind,
      now,
    );
    const { changes } = await this.sql.run("DELETE FROM auth_challenges WHERE id = ?", id);
    return r && changes === 1
      ? {
          challenge: r.challenge,
          accountId: r.account_id,
          data: r.data === null ? null : (JSON.parse(r.data) as unknown),
        }
      : undefined;
  }

  async addPasskey(p: Omit<Passkey, "lastUsedAt">): Promise<void> {
    await this.sql.run(
      `INSERT INTO passkeys (id, account_id, public_key, counter, transports, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.accountId,
      p.publicKey,
      p.counter,
      JSON.stringify(p.transports),
      p.name,
      p.createdAt,
    );
  }

  async getPasskey(id: string): Promise<Passkey | undefined> {
    const r = await this.sql.first<PasskeyRow>("SELECT * FROM passkeys WHERE id = ?", id);
    return r && toPasskey(r);
  }

  async listPasskeys(accountId: string): Promise<Passkey[]> {
    const rows = await this.sql.all<PasskeyRow>(
      "SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at",
      accountId,
    );
    return rows.map(toPasskey);
  }

  async touchPasskey(id: string, counter: number, now: number): Promise<void> {
    await this.sql.run(
      "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?",
      counter,
      now,
      id,
    );
  }

  async deletePasskey(id: string, accountId: string): Promise<boolean> {
    const { changes } = await this.sql.run(
      "DELETE FROM passkeys WHERE id = ? AND account_id = ?",
      id,
      accountId,
    );
    return changes === 1;
  }

  // --- voicemail ----------------------------------------------------------------

  async createVoicemail(v: Omit<Voicemail, "id" | "transcript" | "heardAt">): Promise<Voicemail> {
    const vm: Voicemail = { ...v, id: newId("vm"), transcript: null, heardAt: null };
    await this.sql.run(
      `INSERT INTO voicemails (id, household_id, device_id, from_user, from_label, created_at,
         duration_ms, mime, blob_key, transcript_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      vm.id,
      vm.householdId,
      vm.deviceId,
      vm.fromUser,
      vm.fromLabel,
      vm.createdAt,
      vm.durationMs,
      vm.mime,
      vm.blobKey,
      vm.transcriptStatus,
    );
    return vm;
  }

  async getVoicemail(id: string): Promise<Voicemail | undefined> {
    const r = await this.sql.first<VoicemailRow>("SELECT * FROM voicemails WHERE id = ?", id);
    return r && toVoicemail(r);
  }

  async listVoicemails(householdId: string, limit = 100): Promise<Voicemail[]> {
    const rows = await this.sql.all<VoicemailRow>(
      "SELECT * FROM voicemails WHERE household_id = ? ORDER BY created_at DESC LIMIT ?",
      householdId,
      limit,
    );
    return rows.map(toVoicemail);
  }

  /** Callers with unheard voicemail for a device, newest first, one entry per caller. */
  async unheardFrom(deviceId: string, limit = 8): Promise<string[]> {
    const rows = await this.sql.all<{ from_label: string }>(
      `SELECT from_label, MAX(created_at) AS latest FROM voicemails
       WHERE device_id = ? AND heard_at IS NULL
       GROUP BY from_label ORDER BY latest DESC LIMIT ?`,
      deviceId,
      limit,
    );
    return rows.map((r) => r.from_label);
  }

  async setTranscript(id: string, status: TranscriptStatus, text: string | null): Promise<void> {
    await this.sql.run(
      "UPDATE voicemails SET transcript_status = ?, transcript = ? WHERE id = ?",
      status,
      text,
      id,
    );
  }

  async markVoicemailHeard(id: string, now: number): Promise<void> {
    await this.sql.run(
      "UPDATE voicemails SET heard_at = COALESCE(heard_at, ?) WHERE id = ?",
      now,
      id,
    );
  }

  async deleteVoicemail(id: string): Promise<void> {
    await this.sql.run("DELETE FROM voicemails WHERE id = ?", id);
  }
}
