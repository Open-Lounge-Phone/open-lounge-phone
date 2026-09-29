// Team and org spaces as a workplace phone system (migration 0017): extensions, ring groups,
// business hours and the audit trail. See docs/workplace.md.
import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

export type ExtensionKind = "user" | "device" | "room" | "group";

export interface Extension {
  householdId: string;
  number: string;
  kind: ExtensionKind;
  targetId: string;
}

export type HuntStrategy = "simultaneous" | "sequential" | "round_robin";
export const HUNT_STRATEGIES: readonly HuntStrategy[] = [
  "simultaneous",
  "sequential",
  "round_robin",
];

/** One open window, in the space's local time ("Mon–Fri 09:00–17:00" = days [1..5]). */
export interface HoursRule {
  days: number[];
  start: string;
  end: string;
}

/** What happens to a call to a ring group while it's closed. */
export type AfterHours =
  /** The called group's shared voicemail box. */
  | { kind: "voicemail" }
  /** Ring another group instead (once: it never forwards again). */
  | { kind: "group"; groupId: string }
  /** Ring a member instead. */
  | { kind: "user"; userId: string };

export interface RingGroup {
  id: string;
  householdId: string;
  name: string;
  strategy: HuntStrategy;
  ringSeconds: number;
  /** Round robin: the member position the next call starts with. */
  nextIndex: number;
  /** Member user ids in ring order. */
  members: string[];
  /** Its own open hours; null = the space's. */
  hours: HoursRule[] | null;
  /** Its own after-hours action; null = the space's (else its voicemail). */
  afterHours: AfterHours | null;
  createdAt: number;
}

export interface AuditEntry {
  id: string;
  householdId: string;
  at: number;
  actorAccount: string | null;
  actorName: string;
  action: string;
  detail: Record<string, unknown> | null;
}

type GroupRow = {
  id: string;
  household_id: string;
  name: string;
  strategy: HuntStrategy;
  ring_seconds: number;
  next_index: number;
  hours: string | null;
  after_hours: string | null;
  created_at: number;
};

const parse = <T>(json: string | null): T | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
};

export const DEFAULT_GROUP_RING_SECONDS = 20;

export class WorkplaceStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  // --- extensions -------------------------------------------------------------------------

  async extensions(householdId: string): Promise<Extension[]> {
    const rows = await this.sql.all<{ number: string; kind: ExtensionKind; target_id: string }>(
      "SELECT number, kind, target_id FROM extensions WHERE household_id = ? ORDER BY number",
      householdId,
    );
    return rows.map((r) => ({
      householdId,
      number: r.number,
      kind: r.kind,
      targetId: r.target_id,
    }));
  }

  async extension(householdId: string, number: string): Promise<Extension | undefined> {
    const r = await this.sql.first<{ kind: ExtensionKind; target_id: string }>(
      "SELECT kind, target_id FROM extensions WHERE household_id = ? AND number = ?",
      householdId,
      number,
    );
    return r && { householdId, number, kind: r.kind, targetId: r.target_id };
  }

  /**
   * Gives a target its number (replacing the target's old one). False when the number is taken
   * by something else.
   */
  async setExtension(e: Extension, now: number): Promise<boolean> {
    const taken = await this.extension(e.householdId, e.number);
    if (taken && (taken.kind !== e.kind || taken.targetId !== e.targetId)) return false;
    try {
      await this.sql.batch([
        {
          query: "DELETE FROM extensions WHERE household_id = ? AND kind = ? AND target_id = ?",
          params: [e.householdId, e.kind, e.targetId],
        },
        {
          query: `INSERT INTO extensions (household_id, number, kind, target_id, created_at)
            VALUES (?, ?, ?, ?, ?)`,
          params: [e.householdId, e.number, e.kind, e.targetId, now],
        },
      ]);
    } catch (err) {
      if (/UNIQUE|constraint/i.test(String(err))) return false;
      throw err;
    }
    return true;
  }

  async deleteExtension(householdId: string, number: string): Promise<boolean> {
    const { changes } = await this.sql.run(
      "DELETE FROM extensions WHERE household_id = ? AND number = ?",
      householdId,
      number,
    );
    return changes === 1;
  }

  /** A target went away (a person left, a phone was removed, a room or group deleted). */
  async dropTarget(kind: ExtensionKind, targetId: string): Promise<void> {
    await this.sql.run("DELETE FROM extensions WHERE kind = ? AND target_id = ?", kind, targetId);
  }

  // --- ring groups --------------------------------------------------------------------------

  private async members(groupId: string): Promise<string[]> {
    const rows = await this.sql.all<{ user_id: string }>(
      "SELECT user_id FROM ring_group_members WHERE group_id = ? ORDER BY position, user_id",
      groupId,
    );
    return rows.map((r) => r.user_id);
  }

  private async toGroup(r: GroupRow): Promise<RingGroup> {
    return {
      id: r.id,
      householdId: r.household_id,
      name: r.name,
      strategy: r.strategy,
      ringSeconds: r.ring_seconds,
      nextIndex: r.next_index,
      members: await this.members(r.id),
      hours: parse<HoursRule[]>(r.hours),
      afterHours: parse<AfterHours>(r.after_hours),
      createdAt: r.created_at,
    };
  }

  async groups(householdId: string): Promise<RingGroup[]> {
    const rows = await this.sql.all<GroupRow>(
      "SELECT * FROM ring_groups WHERE household_id = ? ORDER BY created_at, id",
      householdId,
    );
    return Promise.all(rows.map((r) => this.toGroup(r)));
  }

  async group(id: string): Promise<RingGroup | undefined> {
    const r = await this.sql.first<GroupRow>("SELECT * FROM ring_groups WHERE id = ?", id);
    return r ? this.toGroup(r) : undefined;
  }

  /** The groups a member is in (their shared voicemail boxes). */
  async groupsOf(userId: string): Promise<string[]> {
    const rows = await this.sql.all<{ group_id: string }>(
      "SELECT group_id FROM ring_group_members WHERE user_id = ?",
      userId,
    );
    return rows.map((r) => r.group_id);
  }

  async createGroup(
    g: Pick<RingGroup, "householdId" | "name" | "strategy" | "ringSeconds" | "members">,
    now: number,
  ): Promise<RingGroup> {
    const id = newId("rg");
    await this.sql.batch([
      {
        query: `INSERT INTO ring_groups (id, household_id, name, strategy, ring_seconds, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        params: [id, g.householdId, g.name, g.strategy, g.ringSeconds, now],
      },
      ...g.members.map((u, i) => ({
        query: "INSERT INTO ring_group_members (group_id, user_id, position) VALUES (?, ?, ?)",
        params: [id, u, i],
      })),
    ]);
    return (await this.group(id)) as RingGroup;
  }

  async updateGroup(
    id: string,
    patch: Partial<
      Pick<RingGroup, "name" | "strategy" | "ringSeconds" | "members" | "hours" | "afterHours">
    >,
  ): Promise<void> {
    const sets: { col: string; value: string | number | null }[] = [];
    if (patch.name !== undefined) sets.push({ col: "name", value: patch.name });
    if (patch.strategy !== undefined) sets.push({ col: "strategy", value: patch.strategy });
    if (patch.ringSeconds !== undefined) {
      sets.push({ col: "ring_seconds", value: patch.ringSeconds });
    }
    if (patch.hours !== undefined) {
      sets.push({ col: "hours", value: patch.hours ? JSON.stringify(patch.hours) : null });
    }
    if (patch.afterHours !== undefined) {
      sets.push({
        col: "after_hours",
        value: patch.afterHours ? JSON.stringify(patch.afterHours) : null,
      });
    }
    const statements = sets.map((s) => ({
      query: `UPDATE ring_groups SET ${s.col} = ? WHERE id = ?`,
      params: [s.value, id],
    }));
    if (patch.members) {
      statements.push({ query: "DELETE FROM ring_group_members WHERE group_id = ?", params: [id] });
      statements.push({
        query: "UPDATE ring_groups SET next_index = 0 WHERE id = ?",
        params: [id],
      });
      for (const [i, u] of patch.members.entries()) {
        statements.push({
          query: "INSERT INTO ring_group_members (group_id, user_id, position) VALUES (?, ?, ?)",
          params: [id, u, i],
        });
      }
    }
    if (statements.length) await this.sql.batch(statements);
  }

  /** Round robin: the next call starts with the member after this one. */
  async setNextIndex(id: string, next: number): Promise<void> {
    await this.sql.run("UPDATE ring_groups SET next_index = ? WHERE id = ?", next, id);
  }

  async deleteGroup(id: string): Promise<void> {
    await this.sql.batch([
      {
        query: "DELETE FROM extensions WHERE kind = 'group' AND target_id = ?",
        params: [id],
      },
      { query: "DELETE FROM ring_groups WHERE id = ?", params: [id] },
    ]);
  }

  // --- business hours ---------------------------------------------------------------------

  async spaceHours(
    householdId: string,
  ): Promise<{ hours: HoursRule[] | null; afterHours: AfterHours | null }> {
    const r = await this.sql.first<{ business_hours: string | null; after_hours: string | null }>(
      "SELECT business_hours, after_hours FROM households WHERE id = ?",
      householdId,
    );
    return {
      hours: parse<HoursRule[]>(r?.business_hours ?? null),
      afterHours: parse<AfterHours>(r?.after_hours ?? null),
    };
  }

  async setSpaceHours(
    householdId: string,
    v: { hours?: HoursRule[] | null; afterHours?: AfterHours | null },
  ): Promise<void> {
    if (v.hours !== undefined) {
      await this.sql.run(
        "UPDATE households SET business_hours = ? WHERE id = ?",
        v.hours ? JSON.stringify(v.hours) : null,
        householdId,
      );
    }
    if (v.afterHours !== undefined) {
      await this.sql.run(
        "UPDATE households SET after_hours = ? WHERE id = ?",
        v.afterHours ? JSON.stringify(v.afterHours) : null,
        householdId,
      );
    }
  }

  // --- audit --------------------------------------------------------------------------------

  async audit(e: Omit<AuditEntry, "id">): Promise<void> {
    await this.sql.run(
      `INSERT INTO audit_log (id, household_id, at, actor_account, actor_name, action, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId("au"),
      e.householdId,
      e.at,
      e.actorAccount,
      e.actorName.slice(0, 64),
      e.action,
      e.detail ? JSON.stringify(e.detail) : null,
    );
  }

  /** Newest first; `before` pages back. */
  async auditLog(householdId: string, limit = 200, before?: number): Promise<AuditEntry[]> {
    const rows = await this.sql.all<{
      id: string;
      at: number;
      actor_account: string | null;
      actor_name: string;
      action: string;
      detail: string | null;
    }>(
      `SELECT * FROM audit_log WHERE household_id = ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?`,
      householdId,
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    );
    return rows.map((r) => ({
      id: r.id,
      householdId,
      at: r.at,
      actorAccount: r.actor_account,
      actorName: r.actor_name,
      action: r.action,
      detail: parse<Record<string, unknown>>(r.detail),
    }));
  }
}
