// Call waiting settings (docs/phone-ux.md "Call waiting"): on unless turned off. A person's own
// (their apps and own phones follow it), and a household phone's (a kid's), set by its guardians.

import type { User } from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { body, type Vars } from "./httpUtil.ts";

const Setting = z.object({ on: z.boolean() });

export function callWaitingRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  api.get("/call-waiting", async (c) =>
    c.json({ on: await store.callWaiting({ accountId: c.get("account").id }) }),
  );

  api.put("/call-waiting", async (c) => {
    const b = await body(c.req.raw, Setting);
    if (b instanceof Response) return b;
    await store.setCallWaiting({ accountId: c.get("account").id }, b.on);
    return c.json({ on: b.on });
  });

  /** A household phone of this space (a person's own phone follows its owner's setting). */
  const householdPhone = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    if (!device || device.householdId !== user.householdId) return undefined;
    if (device.ownerUserId || device.kind === "lounge") return undefined;
    return device;
  };

  api.get("/devices/:id/call-waiting", async (c) => {
    const device = await householdPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    return c.json({ on: await store.callWaiting({ deviceId: device.id }) });
  });

  api.put("/devices/:id/call-waiting", async (c) => {
    if (c.get("user").role !== "guardian") return c.json({ error: "guardians only" }, 403);
    const device = await householdPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, Setting);
    if (b instanceof Response) return b;
    await store.setCallWaiting({ deviceId: device.id }, b.on);
    return c.json({ on: b.on });
  });
}
