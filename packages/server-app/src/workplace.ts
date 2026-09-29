// Team and org spaces as a workplace phone system (docs/workplace.md): the directory,
// extensions, ring groups, business hours, roles, the space-wide call log and the audit trail.
// Home spaces are unchanged: every route here answers 400 there.
import {
  csvCell,
  directoryMatch,
  isExtension,
  mayChangeRole,
  type SpaceRole,
  spaceRole,
  validateSchedule,
  type Weekday,
} from "@openloungephone/core";
import {
  type Account,
  type AfterHours,
  deviceMode,
  type ExtensionKind,
  type HoursRule,
  type Household,
  HUNT_STRATEGIES,
  type HuntStrategy,
  type User,
} from "@openloungephone/db";
import { Id } from "@openloungephone/protocol";
import type { Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { dropVoicemailBlobs } from "./voicemail.ts";

/** Most ring groups a space may have. */
export const GROUPS_PER_SPACE = 30;
/** Most members in one ring group. */
export const GROUP_MAX_MEMBERS = 20;

const Number_ = z.string().regex(/^[0-9]{2,6}$/, "an extension is 2–6 digits");
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const Rules = z
  .array(
    z.object({
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      start: HHMM,
      end: HHMM,
    }),
  )
  .max(14);
const Action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("voicemail") }),
  z.object({ kind: z.literal("group"), groupId: Id }),
  z.object({ kind: z.literal("user"), userId: Id }),
]);
const Strategy = z.enum(HUNT_STRATEGIES as [HuntStrategy]);
const RingSeconds = z.number().int().min(5).max(120);
const ExtensionBody = z.object({
  kind: z.enum(["user", "device", "room", "group"]),
  targetId: Id,
});
const GroupBody = z.object({
  name: z.string().trim().min(1).max(40),
  extension: Number_,
  strategy: Strategy.default("simultaneous"),
  ringSeconds: RingSeconds.default(20),
  members: z.array(Id).max(GROUP_MAX_MEMBERS).default([]),
});
const GroupPatch = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    extension: Number_.optional(),
    strategy: Strategy.optional(),
    ringSeconds: RingSeconds.optional(),
    members: z.array(Id).max(GROUP_MAX_MEMBERS).optional(),
    hours: Rules.nullable().optional(),
    afterHours: Action.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to change" });
const HoursBody = z
  .object({ hours: Rules.nullable().optional(), afterHours: Action.nullable().optional() })
  .refine((b) => b.hours !== undefined || b.afterHours !== undefined, {
    message: "nothing to change",
  });
const RoleBody = z.object({ role: z.enum(["admin", "member"]) });

const notWorkplace = "only team and org spaces have a directory, extensions and ring groups";

/** The space if it's a team or org (a workplace), else undefined. */
export async function workplaceSpace(
  env: ServerEnv,
  householdId: string,
): Promise<Household | undefined> {
  const space = await env.store.getHousehold(householdId);
  return space && space.type !== "home" ? space : undefined;
}

/** A member's role in a team/org space: owner, admin or member. */
export async function roleOf(env: ServerEnv, user: User): Promise<SpaceRole> {
  const owner = await env.store.spaceOwner(user.householdId);
  return spaceRole(user.role, owner === user.accountId);
}

/**
 * Records an admin action in a team/org space's audit trail (who changed what). Homes keep no
 * audit trail. Never throws: a failed audit write is logged, not fatal.
 */
export async function audit(
  env: ServerEnv,
  who: { user: User; account: Account },
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    if (!(await workplaceSpace(env, who.user.householdId))) return;
    await env.store.workplace.audit({
      householdId: who.user.householdId,
      at: env.now(),
      actorAccount: who.account.id,
      actorName: who.user.name,
      action,
      detail: detail ?? null,
    });
  } catch (e) {
    env.log("warn", "audit write failed", { action, error: String(e) });
  }
}

/** `audit` from a request's signed-in member. */
export const auditFrom = (
  env: ServerEnv,
  c: Context<Vars>,
  action: string,
  detail?: Record<string, unknown>,
) => audit(env, { user: c.get("user"), account: c.get("account") }, action, detail);

/** The rules of a request's validated hours, as stored. */
const toRules = (rules: z.infer<typeof Rules>): HoursRule[] =>
  rules.map((r) => ({ days: [...new Set(r.days)].sort(), start: r.start, end: r.end }));

export function workplaceRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;
  const wp = store.workplace;

  /** Team/org spaces only. */
  const workplace = createMiddleware<Vars>(async (c, next) => {
    if (!(await workplaceSpace(env, c.get("user").householdId))) {
      return c.json({ error: notWorkplace }, 400);
    }
    await next();
  });
  /** Admins (and the owner) only. */
  const admins = createMiddleware<Vars>(async (c, next) => {
    if (c.get("user").role !== "guardian") return c.json({ error: "admins only" }, 403);
    await next();
  });

  for (const path of [
    "/directory",
    "/extensions",
    "/extensions/*",
    "/groups",
    "/groups/*",
    "/space/hours",
    "/space/calls",
    "/space/calls.csv",
    "/space/audit",
    "/users/:id/role",
  ]) {
    api.use(path, workplace);
  }

  /** Phones learn whether MENU offers "Dial extension". */
  const refreshPhones = async (hh: string) => {
    for (const d of await store.listDevices(hh)) await live.refreshDevice(hh, d.id);
  };

  /** Checks an extension's target belongs to this space. */
  const targetProblem = async (
    hh: string,
    kind: ExtensionKind,
    id: string,
  ): Promise<string | undefined> => {
    if (kind === "user") {
      const u = await store.getUser(id);
      return u?.householdId === hh ? undefined : "not a member of this space";
    }
    if (kind === "device") {
      const d = await store.getDevice(id);
      if (!d || d.householdId !== hh) return "not a phone of this space";
      return deviceMode(d) === "kids" ? "kids' phones have no extension" : undefined;
    }
    if (kind === "room") {
      const r = await store.rooms.get(id);
      return r?.householdId === hh ? undefined : "not a room of this space";
    }
    const g = await wp.group(id);
    return g?.householdId === hh ? undefined : "not a ring group of this space";
  };

  const membersProblem = async (hh: string, ids: string[]): Promise<string | undefined> => {
    if (new Set(ids).size !== ids.length) return "each member once";
    const members = new Set((await store.listUsers(hh)).map((u) => u.id));
    return ids.every((id) => members.has(id)) ? undefined : "not all members of this space";
  };

  const actionProblem = async (hh: string, a: AfterHours | null | undefined) => {
    if (!a || a.kind === "voicemail") return undefined;
    return a.kind === "group"
      ? targetProblem(hh, "group", a.groupId)
      : targetProblem(hh, "user", a.userId);
  };

  const hoursProblem = (space: Household, rules: HoursRule[] | null | undefined) => {
    if (!rules) return undefined;
    try {
      validateSchedule({
        timeZone: space.timeZone,
        rules: rules.map((r) => ({ ...r, days: r.days as Weekday[] })),
      });
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  };

  // --- the directory -----------------------------------------------------------------------

  /** Members, phones, rooms and ring groups of the space, with their extensions; `q` searches. */
  api.get("/directory", async (c) => {
    const user = c.get("user");
    const hh = user.householdId;
    const q = c.req.query("q") ?? "";
    const [users, devices, rooms, groups, exts, owner, availability] = await Promise.all([
      store.listUsers(hh),
      store.listDevices(hh),
      store.rooms.list(hh),
      wp.groups(hh),
      wp.extensions(hh),
      store.spaceOwner(hh),
      store.availability(hh),
    ]);
    const ext = (kind: ExtensionKind, id: string) =>
      exts.find((e) => e.kind === kind && e.targetId === id)?.number ?? null;
    const host = ownHost(env, c.req.url);
    const members = await Promise.all(
      users.map(async (u) => {
        const account = await store.getAccount(u.accountId);
        return {
          id: u.id,
          name: u.name,
          handle: account?.handle ?? null,
          address: account ? `${account.handle}@${host}` : null,
          role: spaceRole(u.role, owner === u.accountId),
          extension: ext("user", u.id),
          available: availability.get(u.id) ?? true,
        };
      }),
    );
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return c.json({
      members: members.filter((m) => directoryMatch(q, m)),
      phones: devices
        .filter((d) => deviceMode(d) !== "kids")
        .map((d) => ({
          id: d.id,
          name: d.name,
          mode: deviceMode(d),
          owner: d.ownerUserId ? (nameOf.get(d.ownerUserId) ?? null) : null,
          extension: ext("device", d.id),
        }))
        .filter((d) => directoryMatch(q, d)),
      rooms: rooms
        .map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          ...(r.handle ? { address: `${r.handle}@${host}` } : {}),
          extension: ext("room", r.id),
        }))
        .filter((r) => directoryMatch(q, r)),
      groups: groups
        .map((g) => ({
          id: g.id,
          name: g.name,
          strategy: g.strategy,
          extension: ext("group", g.id),
          members: g.members.map((m) => nameOf.get(m) ?? ""),
        }))
        .filter((g) => directoryMatch(q, g)),
      you: { id: user.id, role: await roleOf(env, user) },
    });
  });

  // --- extensions --------------------------------------------------------------------------

  api.get("/extensions", async (c) => c.json(await wp.extensions(c.get("user").householdId)));

  api.put("/extensions/:number", admins, async (c) => {
    const hh = c.get("user").householdId;
    const number = c.req.param("number");
    if (!isExtension(number)) return c.json({ error: "an extension is 2–6 digits" }, 400);
    const b = await body(c.req.raw, ExtensionBody);
    if (b instanceof Response) return b;
    const problem = await targetProblem(hh, b.kind, b.targetId);
    if (problem) return c.json({ error: problem }, 400);
    const ok = await wp.setExtension({ householdId: hh, number, ...b }, env.now());
    if (!ok) return c.json({ error: `extension ${number} is taken` }, 409);
    await auditFrom(env, c, "extension.set", { number, kind: b.kind, targetId: b.targetId });
    await refreshPhones(hh);
    return c.body(null, 204);
  });

  api.delete("/extensions/:number", admins, async (c) => {
    const hh = c.get("user").householdId;
    const number = c.req.param("number");
    if (!(await wp.deleteExtension(hh, number))) return c.json({ error: "not found" }, 404);
    await auditFrom(env, c, "extension.delete", { number });
    await refreshPhones(hh);
    return c.body(null, 204);
  });

  // --- ring groups -------------------------------------------------------------------------

  const groupView = async (hh: string, id: string) => {
    const g = await wp.group(id);
    if (!g) return undefined;
    const number = (await wp.extensions(hh)).find(
      (e) => e.kind === "group" && e.targetId === g.id,
    )?.number;
    return { ...g, extension: number ?? null };
  };

  api.get("/groups", async (c) => {
    const hh = c.get("user").householdId;
    const groups = await wp.groups(hh);
    return c.json(await Promise.all(groups.map((g) => groupView(hh, g.id))));
  });

  api.post("/groups", admins, async (c) => {
    const hh = c.get("user").householdId;
    const b = await body(c.req.raw, GroupBody);
    if (b instanceof Response) return b;
    if ((await wp.groups(hh)).length >= GROUPS_PER_SPACE) {
      return c.json({ error: `a space can have ${GROUPS_PER_SPACE} ring groups` }, 400);
    }
    const problem = await membersProblem(hh, b.members);
    if (problem) return c.json({ error: problem }, 400);
    if (await wp.extension(hh, b.extension)) {
      return c.json({ error: `extension ${b.extension} is taken` }, 409);
    }
    const group = await wp.createGroup(
      {
        householdId: hh,
        name: b.name,
        strategy: b.strategy,
        ringSeconds: b.ringSeconds,
        members: b.members,
      },
      env.now(),
    );
    if (
      !(await wp.setExtension(
        { householdId: hh, number: b.extension, kind: "group", targetId: group.id },
        env.now(),
      ))
    ) {
      await wp.deleteGroup(group.id);
      return c.json({ error: `extension ${b.extension} is taken` }, 409);
    }
    await auditFrom(env, c, "group.create", {
      groupId: group.id,
      name: b.name,
      extension: b.extension,
      strategy: b.strategy,
      members: b.members,
    });
    await refreshPhones(hh);
    return c.json(await groupView(hh, group.id), 201);
  });

  api.patch("/groups/:id", admins, async (c) => {
    const hh = c.get("user").householdId;
    const group = await wp.group(c.req.param("id"));
    if (!group || group.householdId !== hh) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, GroupPatch);
    if (b instanceof Response) return b;
    const space = (await store.getHousehold(hh)) as Household;
    const problem =
      (b.members && (await membersProblem(hh, b.members))) ||
      (await actionProblem(hh, b.afterHours)) ||
      hoursProblem(space, b.hours);
    if (problem) return c.json({ error: problem }, 400);
    if (b.extension) {
      const ok = await wp.setExtension(
        { householdId: hh, number: b.extension, kind: "group", targetId: group.id },
        env.now(),
      );
      if (!ok) return c.json({ error: `extension ${b.extension} is taken` }, 409);
    }
    const { extension: _e, hours, ...rest } = b;
    await wp.updateGroup(group.id, {
      ...rest,
      ...(hours !== undefined ? { hours: hours ? toRules(hours) : null } : {}),
    });
    await auditFrom(env, c, "group.update", { groupId: group.id, ...b });
    return c.json(await groupView(hh, group.id));
  });

  api.delete("/groups/:id", admins, async (c) => {
    const hh = c.get("user").householdId;
    const group = await wp.group(c.req.param("id"));
    if (!group || group.householdId !== hh) return c.json({ error: "not found" }, 404);
    // The shared box's audio goes before its rows cascade.
    await dropVoicemailBlobs(env, { groupId: group.id });
    await wp.deleteGroup(group.id);
    await auditFrom(env, c, "group.delete", { groupId: group.id, name: group.name });
    await refreshPhones(hh);
    return c.body(null, 204);
  });

  // --- business hours ----------------------------------------------------------------------

  api.get("/space/hours", async (c) => {
    const hh = c.get("user").householdId;
    const space = (await store.getHousehold(hh)) as Household;
    return c.json({ timeZone: space.timeZone, ...(await wp.spaceHours(hh)) });
  });

  api.put("/space/hours", admins, async (c) => {
    const hh = c.get("user").householdId;
    const b = await body(c.req.raw, HoursBody);
    if (b instanceof Response) return b;
    const space = (await store.getHousehold(hh)) as Household;
    const problem = hoursProblem(space, b.hours) || (await actionProblem(hh, b.afterHours));
    if (problem) return c.json({ error: problem }, 400);
    await wp.setSpaceHours(hh, {
      ...(b.hours !== undefined ? { hours: b.hours ? toRules(b.hours) : null } : {}),
      ...(b.afterHours !== undefined ? { afterHours: b.afterHours } : {}),
    });
    await auditFrom(env, c, "hours.update", b);
    return c.body(null, 204);
  });

  // --- roles -------------------------------------------------------------------------------

  /** The owner makes members admins and back. */
  api.patch("/users/:id/role", async (c) => {
    const me = c.get("user");
    const b = await body(c.req.raw, RoleBody);
    if (b instanceof Response) return b;
    const target = await store.getUser(c.req.param("id"));
    if (!target || target.householdId !== me.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const check = mayChangeRole(await roleOf(env, me), await roleOf(env, target), b.role);
    if (!check.ok) return c.json({ error: check.error }, 403);
    await store.setRole(target.id, b.role === "admin" ? "guardian" : "contact");
    await auditFrom(env, c, "role.change", { userId: target.id, name: target.name, role: b.role });
    return c.body(null, 204);
  });

  // --- the space's call log and audit trail (admins) ---------------------------------------

  const callRows = async (hh: string, limit: number, before?: number) => {
    const entries = await store.spaceCallLog(hh, limit, before);
    const names = new Map<string, string>();
    const nameOf = async (e: (typeof entries)[number]) => {
      const key = e.accountId ?? `d:${e.deviceId}`;
      if (!names.has(key)) {
        let name = "";
        if (e.accountId) {
          name =
            (await store.membership(e.accountId, hh))?.name ??
            (await store.getAccount(e.accountId))?.name ??
            "";
        } else if (e.deviceId) name = (await store.getDevice(e.deviceId))?.name ?? "";
        names.set(key, name);
      }
      return names.get(key) as string;
    };
    return Promise.all(
      entries.map(async (e) => ({
        id: e.id,
        startedAt: e.startedAt,
        direction: e.direction,
        who: await nameOf(e),
        peer: e.peer,
        peerLabel: e.peerLabel,
        answered: e.answered,
        durationMs: e.durationMs,
        endReason: e.endReason,
        voicemailId: e.voicemailId ?? null,
        recordingId: e.recordingId ?? null,
      })),
    );
  };

  const pageParams = (c: Context<Vars>) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    const beforeRaw = Number(c.req.query("before"));
    return { limit, before: Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined };
  };

  api.get("/space/calls", admins, async (c) => {
    const { limit, before } = pageParams(c);
    return c.json(await callRows(c.get("user").householdId, limit, before));
  });

  /** The whole call log as CSV (one row per party on this server), for an admin to keep. */
  api.get("/space/calls.csv", admins, async (c) => {
    const rows = await callRows(c.get("user").householdId, 10_000);
    const header = [
      "started",
      "direction",
      "who",
      "peer",
      "peer_label",
      "answered",
      "duration_s",
      "end_reason",
      "voicemail",
      "recording",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push(
        [
          new Date(r.startedAt).toISOString(),
          r.direction,
          r.who,
          r.peer,
          r.peerLabel,
          r.answered ? "yes" : "no",
          Math.round(r.durationMs / 1000),
          r.endReason,
          r.voicemailId ? "yes" : "no",
          r.recordingId ? "yes" : "no",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    await auditFrom(env, c, "calls.export", { rows: rows.length });
    return new Response(`${lines.join("\r\n")}\r\n`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="call-log.csv"',
        "cache-control": "private, no-store",
      },
    });
  });

  api.get("/space/audit", admins, async (c) => {
    const { limit, before } = pageParams(c);
    return c.json(await wp.auditLog(c.get("user").householdId, limit, before));
  });
}
