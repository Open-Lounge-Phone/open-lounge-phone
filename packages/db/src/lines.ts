// Public lines (migration 0022): a team/org ring group published at its own address, the
// space's blocklist for them, their recent callers, and lines on phones' speed-dial keys.
// See docs/workplace.md "Public lines".
import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type LineWho = "anyone" | "connections" | "allowlist";
export type MaxWaitAction =
  | { kind: "voicemail" }
  | { kind: "group"; groupId: string }
  | { kind: "user"; userId: string }
  | { kind: "end"; message?: string };

/** A ring group's public line: its address, who may call, the queue, voicemail, limits. */
export interface PublicLine {
  groupId: string;
  householdId: string;
  handle: string;
  enabled: boolean;
  displayName: string | null;
  description: string | null;
  who: LineWho;
  allow: string[];
  queue: boolean;
  queueMax: number;
  queueWaitSeconds: number;
  showPosition: boolean;
  offerVoicemail: boolean;
  atMaxWait: MaxWaitAction;
  voicemail: boolean;
  callerPerHour: number | null;
  serverPerHour: number | null;
  greeting: { kind: "name" | "custom"; mime: string; blobKey: string; durationMs: number } | null;
  updatedAt: number;
}

/** What an admin may change (the handle has its own call: it must be free). */
export type LinePatch = Partial<
  Omit<PublicLine, "groupId" | "householdId" | "handle" | "greeting" | "updatedAt">
>;

export interface LineCallerRow {
  id: string;
  groupId: string;
  address: string;
  host: string;
  name: string;
  at: number;
  outcome: string;
}

export interface LineContact {
  /** `ln_…` */
  id: string;
  deviceId: string;
  address: string;
  label: string;
}

export const isLineContactId = (id: string) => id.startsWith("ln_");

/** Recent callers kept per line. */
export const LINE_CALLERS_KEPT = 100;

type Row = {
  group_id: string;
  household_id: string;
  handle: string;
  enabled: number;
  display_name: string | null;
  description: string | null;
  who: LineWho;
  allow: string | null;
  queue: number;
  queue_max: number;
  queue_wait_s: number;
  show_position: number;
  offer_voicemail: number;
  at_max_wait: string | null;
  voicemail: number;
  caller_per_hour: number | null;
  server_per_hour: number | null;
  greeting_kind: "name" | "custom" | null;
  greeting_mime: string | null;
  greeting_blob: string | null;
  greeting_ms: number | null;
  updated_at: number;
};

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toLine = (r: Row): PublicLine => ({
  groupId: r.group_id,
  householdId: r.household_id,
  handle: r.handle,
  enabled: r.enabled === 1,
  displayName: r.display_name,
  description: r.description,
  who: r.who,
  allow: json<string[]>(r.allow, []),
  queue: r.queue === 1,
  queueMax: r.queue_max,
  queueWaitSeconds: r.queue_wait_s,
  showPosition: r.show_position === 1,
  offerVoicemail: r.offer_voicemail === 1,
  atMaxWait: json<MaxWaitAction>(r.at_max_wait, { kind: "voicemail" }),
  voicemail: r.voicemail === 1,
  callerPerHour: r.caller_per_hour,
  serverPerHour: r.server_per_hour,
  greeting:
    r.greeting_kind && r.greeting_blob
      ? {
          kind: r.greeting_kind,
          mime: r.greeting_mime ?? "audio/wav",
          blobKey: r.greeting_blob,
          durationMs: r.greeting_ms ?? 0,
        }
      : null,
  updatedAt: r.updated_at,
});

/** Columns of `LinePatch` fields. */
const COLUMNS: Record<keyof LinePatch, [string, (v: never) => string | number | null]> = {
  enabled: ["enabled", (v: boolean) => (v ? 1 : 0)],
  displayName: ["display_name", (v: string | null) => v],
  description: ["description", (v: string | null) => v],
  who: ["who", (v: LineWho) => v],
  allow: ["allow", (v: string[]) => JSON.stringify(v)],
  queue: ["queue", (v: boolean) => (v ? 1 : 0)],
  queueMax: ["queue_max", (v: number) => v],
  queueWaitSeconds: ["queue_wait_s", (v: number) => v],
  showPosition: ["show_position", (v: boolean) => (v ? 1 : 0)],
  offerVoicemail: ["offer_voicemail", (v: boolean) => (v ? 1 : 0)],
  atMaxWait: ["at_max_wait", (v: MaxWaitAction) => JSON.stringify(v)],
  voicemail: ["voicemail", (v: boolean) => (v ? 1 : 0)],
  callerPerHour: ["caller_per_hour", (v: number | null) => v],
  serverPerHour: ["server_per_hour", (v: number | null) => v],
};

export class LineStore {
  private readonly sql: Sql;
  private readonly reserveMs: number;

  constructor(sql: Sql, reserveMs: number) {
    this.sql = sql;
    this.reserveMs = reserveMs;
  }

  async get(groupId: string): Promise<PublicLine | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM public_lines WHERE group_id = ?", groupId);
    return r && toLine(r);
  }

  async byHandle(handle: string): Promise<PublicLine | undefined> {
    const r = await this.sql.first<Row>(
      "SELECT * FROM public_lines WHERE handle = ?",
      handle.toLowerCase(),
    );
    return r && toLine(r);
  }

  async ofSpace(householdId: string): Promise<PublicLine[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM public_lines WHERE household_id = ? ORDER BY handle",
      householdId,
    );
    return rows.map(toLine);
  }

  /**
   * Gives a group its line address (creating the line, turned off) or a new one. The handle
   * must be free in the shared namespace: no account, room or other line has it, and nobody
   * released it in the last 90 days. False when it isn't.
   */
  async setHandle(
    groupId: string,
    householdId: string,
    handle: string,
    now: number,
  ): Promise<boolean> {
    const free = `NOT EXISTS (SELECT 1 FROM accounts WHERE handle = ?)
      AND NOT EXISTS (SELECT 1 FROM rooms WHERE handle = ?)
      AND NOT EXISTS (SELECT 1 FROM released_handles WHERE handle = ? AND released_at > ?)`;
    const freeParams = [handle, handle, handle, now - this.reserveMs];
    try {
      const existing = await this.get(groupId);
      if (existing) {
        if (existing.handle === handle) return true;
        const { changes } = await this.sql.run(
          `UPDATE public_lines SET handle = ?, updated_at = ? WHERE group_id = ? AND ${free}`,
          handle,
          now,
          groupId,
          ...freeParams,
        );
        return changes === 1;
      }
      const { changes } = await this.sql.run(
        `INSERT INTO public_lines (group_id, household_id, handle, updated_at)
         SELECT ?, ?, ?, ? WHERE ${free}`,
        groupId,
        householdId,
        handle,
        now,
        ...freeParams,
      );
      return changes === 1;
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e))) return false;
      throw e;
    }
  }

  async update(groupId: string, patch: LinePatch, now: number): Promise<void> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof LinePatch, never][]) {
      if (value === undefined) continue;
      const [col, conv] = COLUMNS[key];
      sets.push(`${col} = ?`);
      params.push(conv(value));
    }
    if (!sets.length) return;
    await this.sql.run(
      `UPDATE public_lines SET ${sets.join(", ")}, updated_at = ? WHERE group_id = ?`,
      ...params,
      now,
      groupId,
    );
  }

  /** Drops a line (its address is free again). The group stays. */
  async remove(groupId: string): Promise<void> {
    await this.sql.run("DELETE FROM public_lines WHERE group_id = ?", groupId);
  }

  /** Sets (or with null clears) the line's own greeting; returns the old audio's blob key. */
  async setGreeting(
    groupId: string,
    g: { kind: "name" | "custom"; mime: string; blobKey: string; durationMs: number } | null,
    now: number,
  ): Promise<string | undefined> {
    const before = (await this.get(groupId))?.greeting?.blobKey;
    await this.sql.run(
      `UPDATE public_lines SET greeting_kind = ?, greeting_mime = ?, greeting_blob = ?,
         greeting_ms = ?, updated_at = ? WHERE group_id = ?`,
      g?.kind ?? null,
      g?.mime ?? null,
      g?.blobKey ?? null,
      g?.durationMs ?? null,
      now,
      groupId,
    );
    return before;
  }

  // --- the space's blocklist ----------------------------------------------------------

  async blocks(
    householdId: string,
  ): Promise<{ kind: "address" | "server"; value: string; createdAt: number }[]> {
    const rows = await this.sql.all<{
      kind: "address" | "server";
      value: string;
      created_at: number;
    }>(
      "SELECT kind, value, created_at FROM line_blocks WHERE household_id = ? ORDER BY kind, value",
      householdId,
    );
    return rows.map((r) => ({ kind: r.kind, value: r.value, createdAt: r.created_at }));
  }

  async block(
    householdId: string,
    kind: "address" | "server",
    value: string,
    now: number,
  ): Promise<void> {
    await this.sql.run(
      `INSERT OR IGNORE INTO line_blocks (household_id, kind, value, created_at) VALUES (?, ?, ?, ?)`,
      householdId,
      kind,
      value.toLowerCase(),
      now,
    );
  }

  async unblock(householdId: string, kind: "address" | "server", value: string): Promise<boolean> {
    const { changes } = await this.sql.run(
      "DELETE FROM line_blocks WHERE household_id = ? AND kind = ? AND value = ?",
      householdId,
      kind,
      value.toLowerCase(),
    );
    return changes === 1;
  }

  // --- recent callers ------------------------------------------------------------------

  async logCaller(c: Omit<LineCallerRow, "id"> & { householdId: string }): Promise<void> {
    await this.sql.batch([
      {
        query: `INSERT INTO line_callers (id, group_id, household_id, address, host, name, at, outcome)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          newId("lc"),
          c.groupId,
          c.householdId,
          c.address.toLowerCase(),
          c.host.toLowerCase(),
          c.name.slice(0, 64),
          c.at,
          c.outcome,
        ],
      },
      {
        query: `DELETE FROM line_callers WHERE group_id = ? AND id NOT IN
          (SELECT id FROM line_callers WHERE group_id = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
        params: [c.groupId, c.groupId, LINE_CALLERS_KEPT],
      },
    ]);
  }

  /** Newest first. */
  async callers(groupId: string, limit = 50): Promise<LineCallerRow[]> {
    const rows = await this.sql.all<{
      id: string;
      group_id: string;
      address: string;
      host: string;
      name: string;
      at: number;
      outcome: string;
    }>(
      "SELECT * FROM line_callers WHERE group_id = ? ORDER BY at DESC, rowid DESC LIMIT ?",
      groupId,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      address: r.address,
      host: r.host,
      name: r.name,
      at: r.at,
      outcome: r.outcome,
    }));
  }

  // --- who is connected to the space ---------------------------------------------------

  /** Whether a member of the space has an active connection with this person. */
  async connectedToSpace(householdId: string, host: string, peerAccount: string): Promise<boolean> {
    const r = await this.sql.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM connections c JOIN users u ON u.account_id = c.account_id
       WHERE u.household_id = ? AND c.peer_host = ? AND c.peer_account = ? AND c.state = 'active'`,
      householdId,
      host,
      peerAccount,
    );
    return (r?.n ?? 0) > 0;
  }

  // --- lines on phones ----------------------------------------------------------------

  /** Puts a line (by address) on a phone (or relabels it); returns its `ln_…` id. */
  async addToPhone(deviceId: string, address: string, label: string): Promise<string> {
    await this.sql.run(
      `INSERT INTO line_contacts (id, device_id, address, label) VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id, address) DO UPDATE SET label = excluded.label`,
      newId("ln"),
      deviceId,
      address.toLowerCase(),
      label,
    );
    const r = await this.sql.first<{ id: string }>(
      "SELECT id FROM line_contacts WHERE device_id = ? AND address = ?",
      deviceId,
      address.toLowerCase(),
    );
    return (r as { id: string }).id;
  }

  async onPhone(deviceId: string): Promise<LineContact[]> {
    const rows = await this.sql.all<{
      id: string;
      device_id: string;
      address: string;
      label: string;
    }>("SELECT * FROM line_contacts WHERE device_id = ? ORDER BY label", deviceId);
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      address: r.address,
      label: r.label,
    }));
  }

  async contact(deviceId: string, id: string): Promise<LineContact | undefined> {
    return (await this.onPhone(deviceId)).find((c) => c.id === id);
  }

  async removeFromPhone(deviceId: string, id: string): Promise<void> {
    await this.sql.run("DELETE FROM line_contacts WHERE device_id = ? AND id = ?", deviceId, id);
  }
}
