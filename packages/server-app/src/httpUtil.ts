import { type Account, sha256, type User } from "@openloungephone/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import type { ServerEnv } from "./env.ts";

/**
 * Per-request auth state. `account` and `token` are set for every signed-in request; `member` is
 * the active membership if the account has one; `user` (= `member`) is set on the routes that
 * act inside a household, which is every route after the account routes.
 */
export type Vars = {
  Variables: { user: User; account: Account; token: string; member: User | undefined };
};

/** Header a client sends to act in one of its households (else the session's active one). */
export const HOUSEHOLD_HEADER = "x-household";

/** Parses and validates a JSON body; returns a 400 Response on failure. */
export async function body<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<z.infer<S> | Response> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return Response.json(
      { error: `${issue?.path.join(".") || "body"}: ${issue?.message}` },
      { status: 400 },
    );
  }
  return parsed.data;
}

export const guardianOnly = createMiddleware<Vars>(async (c, next) => {
  if (c.get("user").role !== "guardian") return c.json({ error: "guardians only" }, 403);
  await next();
});

/**
 * The client's IP address, for per-IP rate limits: Cloudflare's header, a trusted proxy's
 * X-Forwarded-For (TRUST_PROXY), or the socket's address (Node).
 */
export function clientIp(env: ServerEnv, c: Context): string {
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf;
  if (env.trustProxy) {
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/** A rate-limit key for an IP address: hashed, so the database never holds addresses. */
export async function ipBucket(prefix: string, ip: string): Promise<string> {
  return `${prefix}:${(await sha256(`olp-ip:${ip}`)).slice(0, 22)}`;
}

/** Relying-party identity: PUBLIC_URL when configured (reverse proxies), else the request URL. */
export function relyingParty(env: ServerEnv, requestUrl: string): { rpID: string; origin: string } {
  const url = new URL(env.publicUrl ?? requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}
