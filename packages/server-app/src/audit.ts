// A space's audit trail (docs/security-model.md "Audit trail"): who changed what, in every space
// (homes, teams and organizations). Append-only: no route edits or deletes an entry; the space's
// history retention sweep (`Store.sweepExpired`) is the only thing that removes them. Readable by
// the space's guardians (homes) or its owner and admins (teams, orgs), never by members, other
// spaces or other servers. An entry holds who, what, when and the ids, names and counts needed to
// understand it, never what anyone said or wrote.
import type { Account, Device, User } from "@openloungephone/db";
import type { Context, Hono } from "hono";
import type { ServerEnv } from "./env.ts";
import { guardianOnly, type Vars } from "./httpUtil.ts";

/**
 * Keys that never reach a stored entry, at any depth: message content (a notice's text, a
 * transcript, audio, a line's spoken or written message) and secrets (tokens, sessions,
 * passwords) or addresses that identify a device on the network. Call sites pass ids, names and
 * counts; this is the backstop.
 */
export const AUDIT_PRIVATE_KEYS: ReadonlySet<string> = new Set([
  "text",
  "lines",
  "transcript",
  "audio",
  "message",
  "description",
  "token",
  "ticket",
  "secret",
  "password",
  "session",
  "passkey",
  "ip",
]);

/** `detail` without private keys (see `AUDIT_PRIVATE_KEYS`), at any depth. */
export function auditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v === null || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!AUDIT_PRIVATE_KEYS.has(k.toLowerCase())) out[k] = clean(x);
    }
    return out;
  };
  return clean(detail) as Record<string, unknown>;
}

/**
 * Records an action in the actor's space's audit trail. Never throws, so the action itself
 * still works: a failed write is logged as an error, for the operator to see.
 */
export async function audit(
  env: ServerEnv,
  who: { user: User; account: Account },
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await env.store.workplace.audit({
      householdId: who.user.householdId,
      at: env.now(),
      actorAccount: who.account.id,
      actorName: who.user.name,
      action,
      detail: detail ? auditDetail(detail) : null,
    });
  } catch (e) {
    env.log("error", "audit write failed", {
      action,
      household: who.user.householdId,
      error: String(e),
    });
  }
}

/** `audit` from a request's signed-in member. */
export const auditFrom = (
  env: ServerEnv,
  c: Context<Vars>,
  action: string,
  detail?: Record<string, unknown>,
) => audit(env, { user: c.get("user"), account: c.get("account") }, action, detail);

/**
 * A change to a phone's settings, audited unless it is the actor's own personal phone (what a
 * person puts on their own phone's keys is theirs, not the space's business).
 */
export const auditPhone = (
  env: ServerEnv,
  c: Context<Vars>,
  device: Pick<Device, "id" | "name" | "ownerUserId">,
  action: string,
  detail: Record<string, unknown> = {},
) =>
  device.ownerUserId === c.get("user").id
    ? Promise.resolve()
    : auditFrom(env, c, action, { deviceId: device.id, phone: device.name, ...detail });

/** `GET /space/audit`: the active space's trail, newest first; `before` pages back. */
export function auditRoutes(api: Hono<Vars>, env: ServerEnv): void {
  api.get("/space/audit", guardianOnly, async (c) => {
    const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit") ?? 200) || 200));
    const beforeRaw = Number(c.req.query("before"));
    const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
    return c.json(await env.store.workplace.auditLog(c.get("user").householdId, limit, before));
  });
}
