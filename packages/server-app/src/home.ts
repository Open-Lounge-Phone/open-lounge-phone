// Home features on a phone (docs/phone-ux.md "Daily check-in", "Chime", "House intercom"): set
// per phone by its guardians (or by the owner, on their own phone), all off by default.
import { hhmm, localClock, localDay, noticeLines } from "@openloungephone/core";
import type { User } from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import { auditPhone } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";

const HomeBody = z
  .object({
    checkinBy: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 10:00")
      .nullable()
      .optional(),
    chimeText: z.string().max(40).nullable().optional(),
    intercom: z.boolean().optional(),
  })
  .strict();

export function homeRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** A phone of this space the member may set up: guardians any, a person their own. */
  const phone = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    if (!device || device.householdId !== user.householdId) return undefined;
    if (user.role !== "guardian" && device.ownerUserId !== user.id) return undefined;
    return device;
  };

  api.get("/devices/:id/home", async (c) => {
    const device = await phone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const h = await store.home.get(device.id);
    return c.json({ checkinBy: h.checkinBy, chimeText: h.chimeText, intercom: h.intercom });
  });

  api.put("/devices/:id/home", async (c) => {
    const device = await phone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    if (device.kind === "lounge") {
      return c.json({ error: "Lounge phones don't have home features" }, 409);
    }
    const b = await body(c.req.raw, HomeBody);
    if (b instanceof Response) return b;
    if (b.checkinBy && hhmm(b.checkinBy) === undefined) {
      return c.json({ error: "a time like 10:00" }, 400);
    }
    let chimeText: string | null | undefined = b.chimeText;
    if (chimeText) {
      const lines = noticeLines(chimeText);
      if ("error" in lines) return c.json({ error: `Chime: ${lines.error}` }, 400);
      chimeText = lines.lines.join("\n");
    }
    await store.home.set(device.id, {
      ...(b.checkinBy !== undefined ? { checkinBy: b.checkinBy } : {}),
      ...(chimeText !== undefined ? { chimeText: chimeText || null } : {}),
      ...(b.intercom !== undefined ? { intercom: b.intercom } : {}),
    });
    if (b.checkinBy) {
      // Set after today's time passed: nothing is asked today (the first day is tomorrow).
      const tz = (await store.getHousehold(device.householdId))?.timeZone ?? "UTC";
      const now = new Date(env.now());
      if (localClock(now, tz).minutes >= (hhmm(b.checkinBy) ?? 0)) {
        await store.home.checkedIn(device.id, localDay(now, tz));
      }
    }
    if (b.intercom) await store.home.intercomKey(device.householdId);
    // Its config now, and the space's timers (a check-in's time).
    await live.spaceChanged(device.householdId);
    // What changed, never the chime's words.
    await auditPhone(env, c, device, "phone.home", {
      ...(b.checkinBy !== undefined ? { checkinBy: b.checkinBy } : {}),
      ...(chimeText !== undefined ? { chime: !!chimeText } : {}),
      ...(b.intercom !== undefined ? { intercom: b.intercom } : {}),
    });
    const h = await store.home.get(device.id);
    return c.json({ checkinBy: h.checkinBy, chimeText: h.chimeText, intercom: h.intercom });
  });
}
