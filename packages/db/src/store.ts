import type {
  ButtonMap,
  Contact,
  QuietHoursRule,
  QuietHoursSchedule,
  Weekday,
} from "@openloungephone/core";
import { newId, newPairingCode, newToken, sha256 } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type Role = "guardian" | "contact";

export interface Household {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
}

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

export type KeyAlg = "ed25519" | "p256";
export type PhoneKind = "kids" | "lounge";

/** A takeover of a Lounge phone; `endedAt` is null while it lasts. */
export interface LoungeSessionRecord {
  id: string;
  deviceId: string;
  userId: string;
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
  user_id: string;
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
};
const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  createdAt: r.created_at,
  handleChangedAt: r.handle_changed_at,
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

/** Typed data access shared by every backend. All times are epoch ms supplied by the caller. */
export class Store {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
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
      const { changes } = await this.sql.run(
        "INSERT OR IGNORE INTO accounts (id, handle, name, created_at) VALUES (?, ?, ?, ?)",
        id,
        handle,
        input.name,
        now,
      );
      if (changes === 1) {
        return { id, handle, name: input.name, createdAt: now, handleChangedAt: null };
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

  /** Changes a handle. Validate with `handleProblem` first. False when it's taken. */
  async setHandle(accountId: string, handle: string, now: number): Promise<boolean> {
    try {
      const { changes } = await this.sql.run(
        "UPDATE accounts SET handle = ?, handle_changed_at = ? WHERE id = ?",
        handle,
        now,
        accountId,
      );
      return changes === 1;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return false;
      throw e;
    }
  }

  async setAccountName(accountId: string, name: string): Promise<void> {
    await this.sql.run("UPDATE accounts SET name = ? WHERE id = ?", name, accountId);
  }

  /** Every household the account belongs to, oldest membership first. */
  async listMemberships(accountId: string): Promise<Membership[]> {
    const rows = await this.sql.all<
      UserRow & { h_name: string; h_time_zone: string; h_created_at: number }
    >(
      `SELECT u.id, u.household_id, u.account_id, u.name, u.role,
         h.name AS h_name, h.time_zone AS h_time_zone, h.created_at AS h_created_at
       FROM users u JOIN households h ON h.id = u.household_id
       WHERE u.account_id = ? ORDER BY u.created_at, u.rowid`,
      accountId,
    );
    return rows.map((r) => ({
      user: toUser(r),
      household: {
        id: r.household_id,
        name: r.h_name,
        timeZone: r.h_time_zone,
        createdAt: r.h_created_at,
      },
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
    input: { name: string; timeZone: string; guardianName: string; accountId?: string },
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
        query: "INSERT INTO households (id, name, time_zone, created_at) VALUES (?, ?, ?, ?)",
        params: [household.id, household.name, household.timeZone, now],
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
    const r = await this.sql.first<{
      id: string;
      name: string;
      time_zone: string;
      created_at: number;
    }>("SELECT * FROM households WHERE id = ?", id);
    return r && { id: r.id, name: r.name, timeZone: r.time_zone, createdAt: r.created_at };
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
  async deleteUser(id: string): Promise<void> {
    const user = await this.getUser(id);
    if (!user) return;
    await this.sql.batch([
      { query: "DELETE FROM users WHERE id = ?", params: [id] },
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
    const r = await this.sql.first<ContactRow>(
      "SELECT * FROM contacts WHERE device_id = ? AND user_id = ?",
      deviceId,
      userId,
    );
    return r && toContact(r);
  }

  async listContacts(deviceId: string): Promise<Contact[]> {
    const rows = await this.sql.all<ContactRow>(
      "SELECT * FROM contacts WHERE device_id = ? ORDER BY label",
      deviceId,
    );
    return rows.map(toContact);
  }

  async setButton(deviceId: string, index: number, userId: string | null): Promise<void> {
    if (userId === null) {
      await this.sql.run("DELETE FROM buttons WHERE device_id = ? AND idx = ?", deviceId, index);
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
      "SELECT idx, user_id FROM buttons WHERE device_id = ? ORDER BY idx",
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
      rules: rows.map((r) => ({
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
  async startLoungeSession(
    input: { householdId: string; deviceId: string; userId: string },
    now: number,
  ): Promise<string> {
    const id = newId("ls");
    await this.sql.run(
      "INSERT INTO lounge_sessions (id, household_id, device_id, user_id, started_at) VALUES (?, ?, ?, ?, ?)",
      id,
      input.householdId,
      input.deviceId,
      input.userId,
      now,
    );
    return id;
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
