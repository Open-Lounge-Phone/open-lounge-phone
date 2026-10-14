// Signed-in sessions and account recovery (docs/security-model.md "Accounts and sign-in"): the
// session list and signing out, the recovery code (made, shown once, used once), and closing the
// live app sockets of sessions that end.
import {
  deviceLabel,
  normalizeRecoveryCode,
  RECOVERY_SESSION_MS,
  recoveryCodeFrom,
  type SessionVia,
} from "@openloungephone/core";
import type { Account, SessionOptions } from "@openloungephone/db";
import { sha256 } from "@openloungephone/db";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { accountView, serverHost } from "./accounts.ts";
import { audit } from "./audit.ts";
import type { AppCloseFilter, ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, clientIp, ipBucket, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";

/** How a new session opened from this request starts (its label comes from the User-Agent). */
export function sessionOptions(
  c: Context,
  via: SessionVia,
  extra: Omit<SessionOptions, "via" | "label"> = {},
): SessionOptions {
  return { via, label: deviceLabel(c.req.header("user-agent")), ...extra };
}

/**
 * Closes an account's live app sockets in all its spaces: every session's, or as `filter` says
 * (only some sessions, or all but one). Signed-out sockets close with "unauthorized".
 */
export async function closeAccountApps(
  env: ServerEnv,
  live: Coordinator,
  accountId: string,
  filter?: AppCloseFilter,
): Promise<void> {
  for (const m of await env.store.listMemberships(accountId)) {
    try {
      await live.closeApps(m.household.id, m.user.id, filter);
    } catch (e) {
      env.log("warn", "closing app sockets failed", { error: String(e) });
    }
  }
}

/**
 * Tells an account's other open apps it was just signed in to without a passkey (a recovery
 * code or a sign-in link). Best effort: the session list shows it either way.
 */
export async function noticeSignIn(
  env: ServerEnv,
  live: Coordinator,
  accountId: string,
  kind: "recovered" | "signin_link",
): Promise<void> {
  try {
    await live.notifyAccount(accountId, { t: "account.notice", kind, at: env.now() });
  } catch (e) {
    env.log("warn", "account notice failed", { error: String(e) });
  }
}

/** Audits something about an account in every space it is in (the account acts as itself). */
export async function auditEverywhere(
  env: ServerEnv,
  account: Account,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  for (const { user } of await env.store.listMemberships(account.id)) {
    await audit(env, { user, account }, action, detail);
  }
}

/** A fresh recovery code: shown once, stored as a hash. */
export async function makeRecoveryCode(env: ServerEnv, accountId: string): Promise<string> {
  const code = recoveryCodeFrom(crypto.getRandomValues(new Uint8Array(18)));
  await env.store.auth.setRecoveryCode(accountId, normalizeRecoveryCode(code) as string, env.now());
  return code;
}

const RecoverBody = z.object({
  handle: z.string().trim().toLowerCase().max(80),
  code: z.string().max(80),
});

/** The one answer for any wrong handle or code. */
const NO_MATCH = "that handle and recovery code don't match";

/** `POST /recover` (signed out): a handle and its recovery code start a new passkey. */
export function publicRecoveryRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.post("/recover", async (c) => {
    const b = await body(c.req.raw, RecoverBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const limits = limitsOf(env);
    // `handle@host` works too (people copy their whole address).
    const handle = b.handle.replace(/@.*$/, "");
    const ipOk = await store.connections.hit(
      await ipBucket("recover-ip", clientIp(env, c)),
      3_600_000,
      limits.recoveryAttemptsPerIpPerHour,
      now,
    );
    // Counted per handle whether or not it exists, so the limit says nothing about that either.
    const handleOk = await store.connections.hit(
      `recover-handle:${(await sha256(`olp-handle:${handle}`)).slice(0, 22)}`,
      3_600_000,
      limits.recoveryAttemptsPerHandlePerHour,
      now,
    );
    if (!ipOk || !handleOk) {
      return c.json({ error: "too many tries; wait an hour and try again" }, 429);
    }
    const account = handle ? await store.accountByHandle(handle) : undefined;
    const code = normalizeRecoveryCode(b.code) ?? "";
    // Same work and the same answer for an unknown handle, a wrong code and a code in the wrong
    // shape; a suspended account can't recover either (no hint that it exists).
    const used = await store.auth.useRecoveryCode(account?.id, code);
    if (!used || !account || account.suspendedAt !== null) {
      return c.json({ error: NO_MATCH }, 401);
    }
    const member = (await store.listMemberships(account.id))[0]?.user;
    const { token } = await store.openSession(
      account.id,
      member?.id ?? null,
      now,
      sessionOptions(c, "recovery", { limited: true, ttlMs: RECOVERY_SESSION_MS }),
    );
    // Never the code: who and when is enough.
    await auditEverywhere(env, account, "account.recovered");
    await noticeSignIn(env, live, account.id, "recovered");
    return c.json({ token, account: accountView(account, serverHost(env, c.req.url)) });
  });
}

const SessionIdParam = z.string().min(1).max(64);

/** The session list, signing out, and a new recovery code (signed in). */
export function sessionRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.get("/sessions", async (c) => {
    const current = c.get("session");
    const sessions = await store.auth.sessions(c.get("account").id, env.now());
    return c.json(
      sessions.map((s) => ({
        id: s.id,
        label: s.label,
        via: s.via,
        passkey: s.passkey,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
        current: s.id === current.id,
      })),
    );
  });

  /** Signs out one session (this one, or another of yours). */
  api.delete("/sessions/:id", async (c) => {
    const id = SessionIdParam.safeParse(c.req.param("id"));
    const account = c.get("account");
    if (!id.success || !(await store.auth.endSession(account.id, id.data))) {
      return c.json({ error: "not found" }, 404);
    }
    await closeAccountApps(env, live, account.id, { only: [id.data] });
    return c.body(null, 204);
  });

  /** Signs out everywhere else: every session of yours but this one. */
  api.post("/sessions/sign-out-others", async (c) => {
    const account = c.get("account");
    const keep = c.get("session").id;
    const ended = await store.auth.endSessions(account.id, keep);
    await closeAccountApps(env, live, account.id, { except: keep });
    return c.json({ signedOut: ended.length });
  });

  /**
   * A new recovery code (the old one stops working). Shown once: only its hash is kept. Never
   * logged or audited with the code.
   */
  api.post("/account/recovery-code", async (c) => {
    const code = await makeRecoveryCode(env, c.get("account").id);
    return c.json({ code }, 201);
  });
}
