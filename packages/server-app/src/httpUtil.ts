import type { User } from "@openloungephone/db";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";

export type Vars = { Variables: { user: User } };

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
