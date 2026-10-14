import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

/** A space's stored room (see migration 0016). 3-way calls are live only and never stored. */
export interface Room {
  id: string;
  householdId: string;
  kind: "party" | "phone";
  name: string;
  /** Phone rooms: the name in `handle@host`. */
  handle: string | null;
  ownerAccount: string | null;
  access: "space" | "connections";
  locked: boolean;
  createdAt: number;
  /** Open only in these weekly windows (the space's time zone); null = always (0025). */
  hours: RoomHoursRule[] | null;
  /** The end of the window whose opening was announced (0025). */
  announcedUntil: number | null;
}

/** A weekly window: `days` 0 (Sunday) – 6, `start`/`end` "HH:MM" (past midnight if end ≤ start). */
export interface RoomHoursRule {
  days: number[];
  start: string;
  end: string;
}

/** A room on a phone's allow-list (`rk_…` id, usable on a speed-dial key). */
export interface RoomContact {
  id: string;
  deviceId: string;
  roomId: string;
  label: string;
}

type Row = {
  id: string;
  household_id: string;
  kind: "party" | "phone";
  name: string;
  handle: string | null;
  owner_account: string | null;
  access: "space" | "connections";
  locked: number;
  created_at: number;
  hours: string | null;
  announced_until: number | null;
};

const rulesOf = (s: string | null): RoomHoursRule[] | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as RoomHoursRule[];
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    return null;
  }
};

const toRoom = (r: Row): Room => ({
  id: r.id,
  householdId: r.household_id,
  kind: r.kind,
  name: r.name,
  handle: r.handle,
  ownerAccount: r.owner_account,
  access: r.access,
  locked: r.locked === 1,
  createdAt: r.created_at,
  hours: rulesOf(r.hours ?? null),
  announcedUntil: r.announced_until ?? null,
});

/** Room allow-list entries on phones have ids with this prefix. */
export const isRoomContactId = (id: string) => id.startsWith("rk_");

export class RoomStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Creates a room. A phone room's handle must be free (checked by the caller); null if taken. */
  async create(
    r: Omit<Room, "id" | "createdAt" | "locked" | "hours" | "announcedUntil">,
    now: number,
  ): Promise<Room | undefined> {
    const id = newId("rm");
    try {
      await this.sql.run(
        `INSERT INTO rooms (id, household_id, kind, name, handle, owner_account, access, locked, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?
         WHERE ? IS NULL OR (NOT EXISTS (SELECT 1 FROM accounts WHERE handle = ?)
           AND NOT EXISTS (SELECT 1 FROM public_lines WHERE handle = ?))`,
        id,
        r.householdId,
        r.kind,
        r.name,
        r.handle,
        r.ownerAccount,
        r.access,
        now,
        r.handle,
        r.handle,
        r.handle,
      );
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return undefined;
      throw e;
    }
    return this.get(id);
  }

  async get(id: string): Promise<Room | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM rooms WHERE id = ?", id);
    return r && toRoom(r);
  }

  async byHandle(handle: string): Promise<Room | undefined> {
    const r = await this.sql.first<Row>(
      "SELECT * FROM rooms WHERE handle = ?",
      handle.toLowerCase(),
    );
    return r && toRoom(r);
  }

  async list(householdId: string): Promise<Room[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM rooms WHERE household_id = ? ORDER BY kind, name",
      householdId,
    );
    return rows.map(toRoom);
  }

  async update(
    id: string,
    patch: { name?: string; access?: Room["access"]; locked?: boolean },
  ): Promise<void> {
    await this.sql.run(
      `UPDATE rooms SET name = COALESCE(?, name), access = COALESCE(?, access),
         locked = COALESCE(?, locked) WHERE id = ?`,
      patch.name ?? null,
      patch.access ?? null,
      patch.locked === undefined ? null : patch.locked ? 1 : 0,
      id,
    );
  }

  /** Sets (or with null clears) a room's opening hours; a new schedule announces afresh. */
  async setHours(id: string, hours: RoomHoursRule[] | null): Promise<void> {
    await this.sql.run(
      "UPDATE rooms SET hours = ?, announced_until = NULL WHERE id = ?",
      hours?.length ? JSON.stringify(hours) : null,
      id,
    );
  }

  /** The opening of the window ending at `until` was announced. */
  async setAnnounced(id: string, until: number): Promise<void> {
    await this.sql.run("UPDATE rooms SET announced_until = ? WHERE id = ?", until, id);
  }

  /** Phones with this room on their allow-list (its key). */
  async phonesWith(roomId: string): Promise<string[]> {
    const rows = await this.sql.all<{ device_id: string }>(
      "SELECT device_id FROM room_contacts WHERE room_id = ?",
      roomId,
    );
    return rows.map((r) => r.device_id);
  }

  async delete(id: string): Promise<void> {
    await this.sql.batch([
      { query: "DELETE FROM extensions WHERE kind = 'room' AND target_id = ?", params: [id] },
      { query: "DELETE FROM rooms WHERE id = ?", params: [id] },
    ]);
  }

  // --- rooms on phones ---------------------------------------------------------

  /** Puts a room on a phone's allow-list (or relabels it); returns its `rk_…` id. */
  async addToPhone(deviceId: string, roomId: string, label: string): Promise<string> {
    await this.sql.run(
      `INSERT INTO room_contacts (id, device_id, room_id, label) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, room_id) DO UPDATE SET label = excluded.label`,
      newId("rk"),
      deviceId,
      roomId,
      label,
    );
    const r = await this.sql.first<{ id: string }>(
      "SELECT id FROM room_contacts WHERE device_id = ? AND room_id = ?",
      deviceId,
      roomId,
    );
    return (r as { id: string }).id;
  }

  async onPhone(deviceId: string): Promise<RoomContact[]> {
    const rows = await this.sql.all<{
      id: string;
      device_id: string;
      room_id: string;
      label: string;
    }>("SELECT * FROM room_contacts WHERE device_id = ? ORDER BY label", deviceId);
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      roomId: r.room_id,
      label: r.label,
    }));
  }

  async contact(deviceId: string, id: string): Promise<RoomContact | undefined> {
    return (await this.onPhone(deviceId)).find((c) => c.id === id);
  }

  /** Whether a room is on a phone's allow-list. */
  async allowedOn(deviceId: string, roomId: string): Promise<boolean> {
    const r = await this.sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM room_contacts WHERE device_id = ? AND room_id = ?",
      deviceId,
      roomId,
    );
    return (r?.n ?? 0) > 0;
  }

  async removeFromPhone(deviceId: string, id: string): Promise<void> {
    await this.sql.run("DELETE FROM room_contacts WHERE device_id = ? AND id = ?", deviceId, id);
  }
}
