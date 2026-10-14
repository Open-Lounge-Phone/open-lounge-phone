// Public lines (docs/workplace.md "Public lines"): a team or org ring group published at its own
// address, callable by people on any server without connecting first. This file has the admin
// API (the line's settings, its blocklist, recent callers, its greeting, lines on phones' keys)
// and the admission check every call to a line passes (`admitLineCall`). The queue lives in the
// hub. Every refusal answers like an unavailable line, so nobody can probe for lines or blocks.
import {
  CALLBACK_MISSED,
  type CallbackMissed,
  effectiveLimit,
  LINE_ALLOW_MAX,
  LINE_QUEUE_MAX,
  LINE_WAIT_MAX_SECONDS,
  LINE_WAIT_MIN_SECONDS,
  lineAdmits,
  lineEntry,
} from "@openloungephone/core";
import {
  deviceMode,
  handleProblem,
  LOCAL_HOST,
  type PublicLine,
  type RingGroup,
} from "@openloungephone/db";
import {
  type AddonAddress,
  formatAddonAddress,
  parseAddonAddress,
  parseAddress,
} from "@openloungephone/federation";
import { Id, type LineInfo } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { ADDONS_OFF } from "./addons.ts";
import { auditFrom, auditPhone } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";
import { readGreeting } from "./voicemail.ts";
import { workplaceSpace } from "./workplace.ts";

/** What an admin confirms before a line goes public (the companion shows the same words). */
export const LINE_WARNING =
  "Anyone on a server you haven't blocked can call this line. Their verified address shows on every call, and you can block people and whole servers.";

/** The window of the per-line rate limits. */
const HOUR_MS = 60 * 60 * 1000;

const Entry = z
  .string()
  .max(300)
  .transform((v, ctx) => {
    const e = lineEntry(v);
    if (!e) {
      ctx.addIssue({ code: "custom", message: `${v} isn't a server or an address` });
      return z.NEVER;
    }
    return e.value;
  });
const MaxWait = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("voicemail") }),
  z.object({ kind: z.literal("group"), groupId: Id }),
  z.object({ kind: z.literal("user"), userId: Id }),
  z.object({ kind: z.literal("end"), message: z.string().trim().min(1).max(140).optional() }),
]);
const PerHour = z.number().int().min(1).max(10_000).nullable();
const LineBody = z
  .object({
    handle: z.string().trim().toLowerCase().optional(),
    enabled: z.boolean().optional(),
    /** Turning a line on needs this: the admin saw `LINE_WARNING`. */
    confirm: z.literal(true).optional(),
    displayName: z.string().trim().min(1).max(64).nullable().optional(),
    description: z.string().trim().min(1).max(140).nullable().optional(),
    who: z.enum(["anyone", "connections", "allowlist"]).optional(),
    allow: z.array(Entry).max(LINE_ALLOW_MAX).optional(),
    queue: z.boolean().optional(),
    queueMax: z.number().int().min(1).max(LINE_QUEUE_MAX).optional(),
    queueWaitSeconds: z
      .number()
      .int()
      .min(LINE_WAIT_MIN_SECONDS)
      .max(LINE_WAIT_MAX_SECONDS)
      .optional(),
    showPosition: z.boolean().optional(),
    offerVoicemail: z.boolean().optional(),
    atMaxWait: MaxWait.optional(),
    voicemail: z.boolean().optional(),
    callerPerHour: PerHour.optional(),
    serverPerHour: PerHour.optional(),
    /** Waiting callers may ask to be called back (on by default). */
    callback: z.boolean().optional(),
    /** A missed call back: one more try later (`retry`), or the voicemail offer at once. */
    callbackMissed: z.enum(CALLBACK_MISSED as [CallbackMissed, ...CallbackMissed[]]).optional(),
  })
  .strict();
const BlockBody = z.object({ entry: Entry });
const PhoneLine = z.object({
  address: z.string().trim().min(3).max(300),
  label: z.string().trim().min(1).max(24),
});

/** A line's address on this server. */
export const lineAddress = (env: ServerEnv, line: { handle: string }, url?: string) =>
  `${line.handle}@${ownHost(env, url)}`;

/** What callers and the members it rings see of a line. */
export function lineInfo(
  env: ServerEnv,
  line: PublicLine,
  group: Pick<RingGroup, "name">,
): LineInfo {
  return {
    name: (line.displayName ?? group.name).slice(0, 64),
    ...(line.description ? { description: line.description } : {}),
    address: lineAddress(env, line),
  };
}

/** Someone calling a line, as their server vouches for them. */
export interface LineCallerInfo {
  /** `handle@host`. */
  address: string;
  /** Their server; '' = this one. */
  host: string;
  /** Their stable account id on their server. */
  accountId: string;
  name: string;
  kidsPhone: boolean;
}

/**
 * Whether a call gets through to a line: published, not from a kids' phone, not blocked (the
 * space's list; the operator's applies before any request gets here), allowed by the line's
 * "who can call", and within its limits per caller and per server. Refused callers are listed
 * among the line's recent callers (so admins can see and block them), except when the line is
 * off.
 */
export async function admitLineCall(
  env: ServerEnv,
  line: PublicLine,
  caller: LineCallerInfo,
  /** `counted: false`: calling back in after the line's call back (not another call). */
  opts: { counted?: boolean } = {},
): Promise<boolean> {
  const { store } = env;
  const host = caller.host === LOCAL_HOST ? ownHost(env) : caller.host;
  const [blockRows, member, connected] = await Promise.all([
    store.lines.blocks(line.householdId),
    caller.host === LOCAL_HOST
      ? store.membership(caller.accountId, line.householdId).then((m) => !!m)
      : Promise.resolve(false),
    store.lines.connectedToSpace(line.householdId, caller.host, caller.accountId),
  ]);
  const blocks = {
    addresses: new Set(blockRows.filter((b) => b.kind === "address").map((b) => b.value)),
    servers: new Set(blockRows.filter((b) => b.kind === "server").map((b) => b.value)),
  };
  const verdict = lineAdmits(
    line,
    { address: caller.address, host, kidsPhone: caller.kidsPhone, member, connected },
    blocks,
  );
  if (!verdict.ok && verdict.why === "disabled") return false;
  let ok = verdict.ok;
  if (ok && !member && opts.counted !== false) {
    const limits = limitsOf(env);
    const now = env.now();
    const perCaller = effectiveLimit(limits.lineCallsPerCallerPerHour, line.callerPerHour);
    ok = await store.connections.hit(
      `line:${line.groupId}:caller:${caller.address.toLowerCase()}`,
      HOUR_MS,
      perCaller,
      now,
    );
    if (ok && caller.host !== LOCAL_HOST) {
      const perServer = effectiveLimit(limits.lineCallsPerServerPerHour, line.serverPerHour);
      ok = await store.connections.hit(
        `line:${line.groupId}:server:${host}`,
        HOUR_MS,
        perServer,
        now,
      );
    }
  }
  if (!ok) {
    await store.lines.logCaller({
      groupId: line.groupId,
      householdId: line.householdId,
      address: caller.address,
      host,
      name: caller.name,
      at: env.now(),
      outcome: "refused",
    });
  }
  return ok;
}

/** Records how a call to a line went, for its "Recent callers" (never throws). */
export async function logLineCaller(
  env: ServerEnv,
  row: { groupId: string; householdId: string; address: string; name: string; outcome: string },
): Promise<void> {
  try {
    const at = row.address.lastIndexOf("@");
    await env.store.lines.logCaller({
      ...row,
      host: at >= 0 ? row.address.slice(at + 1) : "",
      at: env.now(),
    });
  } catch (e) {
    env.log("warn", "line caller log failed", { error: String(e) });
  }
}

/** The line's own greeting (else the spoken default with its name). */
export async function lineGreeting(
  env: ServerEnv,
  groupId: string,
): Promise<
  | { kind: "default" }
  | { kind: "name" | "custom"; audio: { data: ArrayBuffer; contentType: string } }
> {
  const g = (await env.store.lines.get(groupId))?.greeting;
  const blob = g && (await env.blobs.get(g.blobKey));
  return g && blob ? { kind: g.kind, audio: blob } : { kind: "default" };
}

export function lineRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** Admins of a team/org space, for one of its groups. */
  const adminGroup = async (user: { householdId: string; role: string }, id: string) => {
    if (user.role !== "guardian") return { error: "admins only", status: 403 as const };
    if (!(await workplaceSpace(env, user.householdId))) {
      return { error: "only team and org spaces have public lines", status: 400 as const };
    }
    const group = await store.workplace.group(id);
    if (!group || group.householdId !== user.householdId) {
      return { error: "not found", status: 404 as const };
    }
    return { group };
  };

  const view = (line: PublicLine | undefined, url: string) =>
    line
      ? {
          handle: line.handle,
          address: lineAddress(env, line, url),
          enabled: line.enabled,
          displayName: line.displayName,
          description: line.description,
          who: line.who,
          allow: line.allow,
          queue: line.queue,
          queueMax: line.queueMax,
          queueWaitSeconds: line.queueWaitSeconds,
          showPosition: line.showPosition,
          offerVoicemail: line.offerVoicemail,
          atMaxWait: line.atMaxWait,
          voicemail: line.voicemail,
          callerPerHour: line.callerPerHour,
          serverPerHour: line.serverPerHour,
          callback: line.callback,
          callbackMissed: line.callbackMissed,
          greeting: line.greeting ? line.greeting.kind : "default",
          limits: {
            callerPerHour: limitsOf(env).lineCallsPerCallerPerHour,
            serverPerHour: limitsOf(env).lineCallsPerServerPerHour,
          },
        }
      : null;

  /** A group's public line (null if it has none). */
  api.get("/groups/:id/line", async (c) => {
    const g = await adminGroup(c.get("user"), c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    return c.json({
      line: view(await store.lines.get(g.group.id), c.req.url),
      warning: LINE_WARNING,
    });
  });

  /**
   * Creates or changes a group's line. A new line needs a free `handle` and starts off; turning
   * it on needs `confirm: true` (the admin saw `LINE_WARNING`).
   */
  api.put("/groups/:id/line", async (c) => {
    const user = c.get("user");
    const g = await adminGroup(user, c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    const group = g.group;
    const b = await body(c.req.raw, LineBody);
    if (b instanceof Response) return b;
    const before = await store.lines.get(group.id);
    const { handle, confirm, ...patch } = b;
    if (!before && !handle) return c.json({ error: "choose an address for the line" }, 400);
    if (patch.enabled && !before?.enabled && confirm !== true) {
      return c.json(
        { error: "confirm the warning to make this line public", warning: LINE_WARNING },
        409,
      );
    }
    const a = patch.atMaxWait;
    if (a?.kind === "group") {
      const other = await store.workplace.group(a.groupId);
      if (!other || other.householdId !== user.householdId || other.id === group.id) {
        return c.json({ error: "overflow to another ring group of this space" }, 400);
      }
    }
    if (a?.kind === "user") {
      const u = await store.getUser(a.userId);
      if (u?.householdId !== user.householdId) {
        return c.json({ error: "overflow to a member of this space" }, 400);
      }
    }
    const now = env.now();
    if (handle !== undefined && handle !== before?.handle) {
      const problem = handleProblem(handle, { reserved: false }); // lines may be support@, help@
      if (problem) return c.json({ error: problem }, 400);
      if (!(await store.lines.setHandle(group.id, user.householdId, handle, now))) {
        return c.json({ error: "that address is taken" }, 409);
      }
      await auditFrom(env, c, "line.address", {
        groupId: group.id,
        from: before?.handle ?? null,
        to: handle,
      });
    }
    await store.lines.update(group.id, patch, now);
    const after = (await store.lines.get(group.id)) as PublicLine;
    if (after.enabled !== (before?.enabled ?? false)) {
      await auditFrom(env, c, after.enabled ? "line.enable" : "line.disable", {
        groupId: group.id,
        address: lineAddress(env, after, c.req.url),
        ...(after.enabled ? { warning: "confirmed" } : {}),
      });
    }
    const { enabled: _e, ...settings } = patch;
    if (Object.keys(settings).length) {
      // Which settings changed (and who may call, which matters for safety); not their text.
      await auditFrom(env, c, "line.update", {
        groupId: group.id,
        changed: Object.keys(settings),
        ...(settings.who ? { who: settings.who } : {}),
      });
    }
    return c.json({ line: view(after, c.req.url) });
  });

  /** Unpublishes a line and frees its address (the group stays). */
  api.delete("/groups/:id/line", async (c) => {
    const g = await adminGroup(c.get("user"), c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    const line = await store.lines.get(g.group.id);
    if (!line) return c.json({ error: "not found" }, 404);
    if (line.greeting) await env.blobs.delete(line.greeting.blobKey);
    await store.lines.remove(g.group.id);
    await auditFrom(env, c, "line.delete", { groupId: g.group.id, handle: line.handle });
    return c.body(null, 204);
  });

  /** The line's recent callers (newest first), with their verified addresses. */
  api.get("/groups/:id/line/callers", async (c) => {
    const g = await adminGroup(c.get("user"), c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    const rows = await store.lines.callers(g.group.id);
    return c.json(
      rows.map((r) => ({
        address: r.address,
        server: r.host,
        name: r.name,
        at: r.at,
        outcome: r.outcome,
      })),
    );
  });

  /** The line's own greeting: raw audio with `kind` (name|custom) and `durationMs`. */
  api.put("/groups/:id/line/greeting", async (c) => {
    const g = await adminGroup(c.get("user"), c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    if (!(await store.lines.get(g.group.id))) return c.json({ error: "not found" }, 404);
    const rec = await readGreeting(c.req.raw, c.req.query("kind"), c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    const blobKey = `greeting/line-${g.group.id}-${env.now()}`;
    await env.blobs.put(blobKey, rec.audio, rec.mime);
    const old = await store.lines.setGreeting(
      g.group.id,
      {
        kind: rec.kind as "name" | "custom",
        mime: rec.mime.split(";")[0] ?? rec.mime,
        blobKey,
        durationMs: rec.durationMs,
      },
      env.now(),
    );
    if (old) await env.blobs.delete(old);
    await auditFrom(env, c, "line.greeting", { groupId: g.group.id, kind: rec.kind });
    return c.body(null, 204);
  });

  api.delete("/groups/:id/line/greeting", async (c) => {
    const g = await adminGroup(c.get("user"), c.req.param("id"));
    if ("error" in g) return c.json({ error: g.error }, g.status);
    const old = await store.lines.setGreeting(g.group.id, null, env.now());
    if (old) await env.blobs.delete(old);
    return c.body(null, 204);
  });

  // --- the space's blocklist for its public lines -----------------------------------------

  const adminSpace = async (user: { householdId: string; role: string }) => {
    if (user.role !== "guardian") return { error: "admins only", status: 403 as const };
    if (!(await workplaceSpace(env, user.householdId))) {
      return { error: "only team and org spaces have public lines", status: 400 as const };
    }
    return undefined;
  };

  api.get("/space/line-blocks", async (c) => {
    const no = await adminSpace(c.get("user"));
    if (no) return c.json({ error: no.error }, no.status);
    return c.json(await store.lines.blocks(c.get("user").householdId));
  });

  /** Blocks a caller's address (`ann@far.example`) or a whole server (`far.example`). */
  api.post("/space/line-blocks", async (c) => {
    const no = await adminSpace(c.get("user"));
    if (no) return c.json({ error: no.error }, no.status);
    const b = await body(c.req.raw, BlockBody);
    if (b instanceof Response) return b;
    const kind = b.entry.includes("@") ? "address" : "server";
    await store.lines.block(c.get("user").householdId, kind, b.entry, env.now());
    await auditFrom(env, c, "line.block", { kind, value: b.entry });
    return c.json({ kind, value: b.entry }, 201);
  });

  api.delete("/space/line-blocks/:kind/:value", async (c) => {
    const no = await adminSpace(c.get("user"));
    if (no) return c.json({ error: no.error }, no.status);
    const kind = c.req.param("kind");
    if (kind !== "address" && kind !== "server") return c.json({ error: "not found" }, 404);
    const value = decodeURIComponent(c.req.param("value"));
    if (!(await store.lines.unblock(c.get("user").householdId, kind, value))) {
      return c.json({ error: "not found" }, 404);
    }
    await auditFrom(env, c, "line.unblock", { kind, value });
    return c.body(null, 204);
  });

  // --- lines on phones' keys ----------------------------------------------------------------

  /** A personal (desk) phone you manage. Never a kids' phone, never a Lounge phone. */
  const linePhone = async (user: { id: string; householdId: string; role: string }, id: string) => {
    const d = await store.getDevice(id);
    if (!d || d.householdId !== user.householdId)
      return { status: 404 as const, error: "not found" };
    if (user.role !== "guardian" && d.ownerUserId !== user.id) {
      return { status: 404 as const, error: "not found" };
    }
    if (deviceMode(d) !== "personal") {
      return { status: 400 as const, error: "only personal phones can call public lines" };
    }
    return { device: d };
  };

  /** Puts a public line (by address) on a phone; answers its `ln_…` id for a key. */
  api.put("/devices/:id/lines", async (c) => {
    const user = c.get("user");
    const p = await linePhone(user, c.req.param("id"));
    if ("error" in p) return c.json({ error: p.error }, p.status);
    const b = await body(c.req.raw, PhoneLine);
    if (b instanceof Response) return b;
    // A public line, or an add-on (`handle+name@host`): who may talk to it is checked on
    // every call, and only a person's own phone has such keys (never a kids' phone).
    const addr = parseAddress(b.address);
    const addon = addr ? undefined : parseAddonAddress(b.address);
    if (!addr && !addon) return c.json({ error: "use an address like support@example.org" }, 400);
    if (addon && !env.addons) return c.json({ error: ADDONS_OFF }, 403);
    const address = addr
      ? `${addr.handle}@${addr.host}`
      : formatAddonAddress(addon as AddonAddress);
    const id = await store.lines.addToPhone(p.device.id, address, b.label);
    await live.refreshDevice(user.householdId, p.device.id);
    await auditPhone(env, c, p.device, "phone.line", { contactId: id, address });
    return c.json({ id });
  });

  api.delete("/devices/:id/lines/:contactId", async (c) => {
    const user = c.get("user");
    const p = await linePhone(user, c.req.param("id"));
    if ("error" in p) return c.json({ error: p.error }, p.status);
    await store.lines.removeFromPhone(p.device.id, c.req.param("contactId"));
    await live.refreshDevice(user.householdId, p.device.id);
    await auditPhone(env, c, p.device, "phone.contact.remove", {
      contactId: c.req.param("contactId"),
    });
    return c.body(null, 204);
  });
}
