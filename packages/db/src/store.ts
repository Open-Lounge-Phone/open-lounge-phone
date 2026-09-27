import type {
  ButtonMap,
  Contact,
  QuietHoursRule,
  QuietHoursSchedule,
  Weekday,
} from "@opentincan/core";
import { newId, newPairingCode, newToken, sha256 } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type Role = "guardian" | "contact";

export interface Household {
  id: string;
  name: string;
  timeZone: string;
  createdAt: number;
}

export interface User {
  id: string;
  householdId: string;
  name: string;
  role: Role;
}

export interface Device {
  id: string;
  householdId: string;
  name: string;
  publicKey: string;
  createdAt: number;
  lastSeen: number | null;
}

export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const PAIRING_TTL_MS = 10 * 60 * 1000;

type DeviceRow = {
  id: string;
  household_id: string;
  name: string;
  public_key: string;
  created_at: number;
  last_seen: number | null;
};
type UserRow = { id: string; household_id: string; name: string; role: Role };
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
  createdAt: r.created_at,
  lastSeen: r.last_seen,
});
const toUser = (r: UserRow): User => ({
  id: r.id,
  householdId: r.household_id,
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

  // --- households & users -------------------------------------------------

  async countHouseholds(): Promise<number> {
    const row = await this.sql.first<{ n: number }>("SELECT COUNT(*) AS n FROM households");
    return row?.n ?? 0;
  }

  /** Creates a household with its first guardian. */
  async createHousehold(
    input: { name: string; timeZone: string; guardianName: string },
    now: number,
  ): Promise<{ household: Household; guardian: User }> {
    const household: Household = {
      id: newId("hh"),
      name: input.name,
      timeZone: input.timeZone,
      createdAt: now,
    };
    const guardian: User = {
      id: newId("usr"),
      householdId: household.id,
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
          "INSERT INTO users (id, household_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
        params: [guardian.id, household.id, guardian.name, guardian.role, now],
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

  async createUser(
    input: { householdId: string; name: string; role: Role },
    now: number,
  ): Promise<User> {
    const user: User = { id: newId("usr"), ...input };
    await this.sql.run(
      "INSERT INTO users (id, household_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
      user.id,
      user.householdId,
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

  async listUsers(householdId: string): Promise<User[]> {
    const rows = await this.sql.all<UserRow>(
      "SELECT * FROM users WHERE household_id = ? ORDER BY created_at",
      householdId,
    );
    return rows.map(toUser);
  }

  // --- sessions -----------------------------------------------------------

  /** Returns the bearer token; only its hash is stored. */
  async createSession(userId: string, now: number): Promise<string> {
    const token = newToken();
    await this.sql.run(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      await sha256(token),
      userId,
      now,
      now + SESSION_TTL_MS,
    );
    return token;
  }

  async userForToken(token: string, now: number): Promise<User | undefined> {
    const r = await this.sql.first<UserRow>(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
      await sha256(token),
      now,
    );
    return r && toUser(r);
  }

  async deleteSession(token: string): Promise<void> {
    await this.sql.run("DELETE FROM sessions WHERE token_hash = ?", await sha256(token));
  }

  // --- devices & pairing --------------------------------------------------

  /** Registers a pending pairing and returns its code. Replaces any earlier code for the key. */
  async createPairing(
    publicKey: string,
    now: number,
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
        "INSERT OR IGNORE INTO pairings (code, public_key, expires_at) VALUES (?, ?, ?)",
        code,
        publicKey,
        expiresAt,
      );
      if (changes === 1) return { code, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  /** Claims a pairing code for a household, creating the device. Single use. */
  async claimPairing(
    input: { code: string; householdId: string; name: string },
    now: number,
  ): Promise<Device | undefined> {
    const pending = await this.sql.first<{ public_key: string }>(
      "SELECT public_key FROM pairings WHERE code = ? AND expires_at > ?",
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
      createdAt: now,
      lastSeen: null,
    };
    // A key re-paired to a new household replaces its old device record.
    await this.sql.batch([
      { query: "DELETE FROM devices WHERE public_key = ?", params: [device.publicKey] },
      {
        query:
          "INSERT INTO devices (id, household_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)",
        params: [device.id, device.householdId, device.name, device.publicKey, now],
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
}
