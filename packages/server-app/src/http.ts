import { type QuietHoursRule, validateSchedule, type Weekday } from "@opentincan/core";
import { newToken, sha256, type User } from "@opentincan/db";
import { Id } from "@opentincan/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";

/** Settings key holding the hash of the one-time first-run setup token. */
export const SETUP_TOKEN_KEY = "setup_token_hash";

type Vars = { Variables: { user: User } };

const Name = z.string().trim().min(1).max(24);

const SetupBody = z.object({
  token: z.string().min(1),
  householdName: z.string().trim().min(1).max(64),
  guardianName: Name,
  timeZone: z.string().min(1),
});
const PairBody = z.object({ code: z.string().regex(/^\d{6}$/), name: Name });
const ContactBody = z.object({
  label: Name,
  canCallDevice: z.boolean(),
  deviceCanCall: z.boolean(),
  bypassQuietHours: z.boolean(),
});
const ButtonBody = z.object({ userId: Id.nullable() });
const QuietBody = z.object({
  rules: z
    .array(
      z.object({
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: z.string(),
        end: z.string(),
      }),
    )
    .max(32),
});

async function body<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S> | Response> {
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

/**
 * On an instance with no households, makes sure a one-time setup token exists. Returns the new
 * token so the host can print a setup link, or undefined if setup is done or already pending.
 */
export async function ensureSetupToken(env: ServerEnv): Promise<string | undefined> {
  // Instances without a startup hook (Cloudflare) seed the hash at deploy time instead.
  if ((await env.store.countHouseholds()) > 0) return undefined;
  const token = newToken();
  await env.store.setSetting(SETUP_TOKEN_KEY, await sha256(token));
  return token;
}

/**
 * For hosts without a startup hook (Cloudflare): accepts a deploy-time secret as the setup token
 * until the first household exists.
 */
export async function seedSetupToken(env: ServerEnv, token: string): Promise<void> {
  if (!token || (await env.store.countHouseholds()) > 0) return;
  if (await env.store.getSetting(SETUP_TOKEN_KEY)) return;
  await env.store.setSetting(SETUP_TOKEN_KEY, await sha256(token));
}

/** REST API mounted at `/api`. Transports add the WebSocket routes and static files. */
export function createApi(env: ServerEnv, live: Coordinator): Hono<Vars> {
  const { store } = env;
  const api = new Hono<Vars>();

  api.get("/health", (c) => c.json({ ok: true }));

  // --- first-run setup ------------------------------------------------------

  api.get("/setup", async (c) => c.json({ needed: (await store.countHouseholds()) === 0 }));

  api.post("/setup", async (c) => {
    const b = await body(c.req.raw, SetupBody);
    if (b instanceof Response) return b;
    const expected = await store.getSetting(SETUP_TOKEN_KEY);
    if (!expected || (await sha256(b.token)) !== expected) {
      return c.json({ error: "invalid or used setup token" }, 403);
    }
    try {
      validateSchedule({ timeZone: b.timeZone, rules: [] });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    await store.setSetting(SETUP_TOKEN_KEY, null);
    const now = env.now();
    const { household, guardian } = await store.createHousehold(
      { name: b.householdName, timeZone: b.timeZone, guardianName: b.guardianName },
      now,
    );
    const token = await store.createSession(guardian.id, now);
    return c.json({ token, user: guardian, household }, 201);
  });

  // --- authenticated --------------------------------------------------------

  api.use("/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const user = token ? await store.userForToken(token, env.now()) : undefined;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    c.set("user", user);
    await next();
  });

  const guardianOnly = createMiddleware<Vars>(async (c, next) => {
    if (c.get("user").role !== "guardian") return c.json({ error: "guardians only" }, 403);
    await next();
  });

  /** Loads a device and ensures it belongs to the caller's household. */
  const ownDevice = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    return device && device.householdId === user.householdId ? device : undefined;
  };

  api.get("/me", async (c) => {
    const user = c.get("user");
    return c.json({ user, household: await store.getHousehold(user.householdId) });
  });

  api.post("/logout", async (c) => {
    await store.deleteSession(c.req.header("authorization")?.slice(7) ?? "");
    return c.body(null, 204);
  });

  api.get("/users", async (c) => c.json(await store.listUsers(c.get("user").householdId)));

  api.get("/devices", async (c) => {
    const user = c.get("user");
    const devices = await store.listDevices(user.householdId);
    return c.json(
      await Promise.all(
        devices.map(async (d) => ({
          id: d.id,
          name: d.name,
          online: await live.isOnline(user.householdId, d.id),
          lastSeen: d.lastSeen,
          contact: (await store.getContact(d.id, user.id)) ?? null,
        })),
      ),
    );
  });

  api.post("/devices/pair", guardianOnly, async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, PairBody);
    if (b instanceof Response) return b;
    const device = await store.claimPairing(
      { code: b.code, householdId: user.householdId, name: b.name },
      env.now(),
    );
    if (!device) return c.json({ error: "unknown or expired code" }, 404);
    // The guardian who paired the phone is its first contact, on the first button.
    await store.upsertContact(device.id, {
      id: user.id,
      label: user.name,
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: true,
    });
    await store.setButton(device.id, 0, user.id);
    await live.notifyPaired(b.code, device);
    return c.json({ id: device.id, name: device.name }, 201);
  });

  api.get("/devices/:id/contacts", guardianOnly, async (c) => {
    const device = await ownDevice(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const [contacts, buttons] = await Promise.all([
      store.listContacts(device.id),
      store.listButtons(device.id),
    ]);
    return c.json({ contacts, buttons: Object.fromEntries(buttons) });
  });

  api.put("/devices/:id/contacts/:userId", guardianOnly, async (c) => {
    const user = c.get("user");
    const device = await ownDevice(user, c.req.param("id"));
    const target = await store.getUser(c.req.param("userId"));
    if (!device || !target || target.householdId !== user.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const b = await body(c.req.raw, ContactBody);
    if (b instanceof Response) return b;
    await store.upsertContact(device.id, { id: target.id, ...b });
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.delete("/devices/:id/contacts/:userId", guardianOnly, async (c) => {
    const user = c.get("user");
    const device = await ownDevice(user, c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    await store.removeContact(device.id, c.req.param("userId"));
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.put("/devices/:id/buttons/:index", guardianOnly, async (c) => {
    const user = c.get("user");
    const device = await ownDevice(user, c.req.param("id"));
    const index = Number(c.req.param("index"));
    if (!device) return c.json({ error: "not found" }, 404);
    if (!Number.isInteger(index) || index < 0 || index > 15) {
      return c.json({ error: "index must be 0-15" }, 400);
    }
    const b = await body(c.req.raw, ButtonBody);
    if (b instanceof Response) return b;
    if (b.userId !== null && !(await store.getContact(device.id, b.userId))) {
      return c.json({ error: "add the person to the allow-list first" }, 400);
    }
    await store.setButton(device.id, index, b.userId);
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.get("/quiet-hours", async (c) => c.json(await store.getSchedule(c.get("user").householdId)));

  api.put("/quiet-hours", guardianOnly, async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, QuietBody);
    if (b instanceof Response) return b;
    const household = await store.getHousehold(user.householdId);
    const rules: QuietHoursRule[] = b.rules.map((r) => ({ ...r, days: r.days as Weekday[] }));
    try {
      validateSchedule({ timeZone: household?.timeZone ?? "UTC", rules });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    await store.setQuietRules(user.householdId, rules);
    for (const d of await store.listDevices(user.householdId)) {
      await live.refreshDevice(user.householdId, d.id);
    }
    return c.body(null, 204);
  });

  return api;
}
