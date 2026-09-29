import type { Account, User } from "@openloungephone/db";
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

/** Relying-party identity: PUBLIC_URL when configured (reverse proxies), else the request URL. */
export function relyingParty(env: ServerEnv, requestUrl: string): { rpID: string; origin: string } {
  const url = new URL(env.publicUrl ?? requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}
