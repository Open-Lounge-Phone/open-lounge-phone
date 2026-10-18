// A phone's firmware changes (docs/security-model.md "Firmware changes"): at each signed-in
// connection the build from its hello is compared with the last one kept. A kids' phone's
// guardians hear about firmware that isn't an official update the moment the phone connects
// with it, and with Ask me first the phone waits for their OK. Official updates and every other
// phone's changes go only in the space's audit trail.
import { buildLabel, firmwareChange } from "@openloungephone/core";
import { type Device, deviceMode, type User } from "@openloungephone/db";
import type { PhoneBuild, ServerToApp } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { auditPhone } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, guardianOnly, type Vars } from "./httpUtil.ts";

export interface FirmwareOutcome {
  /** The device as the hub should see it (its hold may have changed). */
  device: Device;
  /** For the space's guardians, live (a kids' phone on firmware that isn't an official update). */
  notice?: Extract<ServerToApp, { t: "phone.firmware" }>;
}

/** Records what the phone runs now and decides what that sets off. */
export async function phoneConnected(
  env: ServerEnv,
  device: Device,
  model: string,
  reported: PhoneBuild | undefined,
): Promise<FirmwareOutcome> {
  const { store } = env;
  const kids = deviceMode(device) === "kids";
  const change = firmwareChange(device.build ?? undefined, reported, {
    model,
    kids,
    askFirst: device.askFirst,
  });
  if (change.kind === "none" || !reported) return { device };
  const next = reported;
  const now = env.now();
  const build = { ...next, at: now };
  await store.setDeviceBuild(device.id, build);
  const out: Device = { ...device, build };
  if (change.kind === "first") return { device: out };
  const from = device.build ? buildLabel(device.build) : "";
  const to = buildLabel(next);
  const held = change.kind === "changed" && change.hold;
  if (held) {
    await store.setDeviceHeld(device.id, now);
    out.heldAt = now;
  }
  await store.workplace
    .audit({
      householdId: device.householdId,
      at: now,
      actorAccount: null,
      actorName: device.name,
      action: change.kind === "official" ? "phone.firmware.update" : "phone.firmware.change",
      detail: {
        deviceId: device.id,
        phone: device.name,
        from,
        to,
        ...(change.kind === "changed" ? { official: false, held } : {}),
      },
    })
    .catch((e) => env.log("error", "audit write failed", { error: String(e) }));
  if (change.kind !== "changed" || !change.notify) return { device: out };
  return {
    device: out,
    notice: {
      t: "phone.firmware",
      deviceId: device.id,
      name: device.name,
      project: next.project,
      version: next.version,
      held,
      at: now,
    },
  };
}

/** What the phone's page shows about its firmware (kids' phones also their Ask me first). */
export function firmwareView(device: Device) {
  const kids = deviceMode(device) === "kids";
  return {
    build: device.build && {
      label: buildLabel(device.build),
      project: device.build.project,
      version: device.build.version,
      official: device.build.official,
      since: device.build.at,
    },
    ...(kids ? { askFirst: device.askFirst, held: device.heldAt !== null } : {}),
  };
}

const AskFirstBody = z.object({ on: z.boolean() }).strict();

/**
 * `PUT /devices/:id/ask-first {on}` and `POST /devices/:id/allow`: a home's guardians set Ask me
 * first on a kids' phone and allow the firmware it waits on. Turning Ask me first off also lets a
 * waiting phone go (there's nothing left to ask).
 */
export function firmwareRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  const kidsPhone = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    if (!device || device.householdId !== user.householdId) return undefined;
    return deviceMode(device) === "kids" ? device : undefined;
  };

  const release = async (device: Device) => {
    if (device.heldAt === null) return;
    await store.setDeviceHeld(device.id, null);
    await live.refreshDevice(device.householdId, device.id);
  };

  api.put("/devices/:id/ask-first", guardianOnly, async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, AskFirstBody);
    if (b instanceof Response) return b;
    await store.setDeviceAskFirst(device.id, b.on);
    if (!b.on) await release(device);
    await auditPhone(env, c, device, "phone.ask_first", { on: b.on });
    return c.json({ on: b.on });
  });

  api.post("/devices/:id/allow", guardianOnly, async (c) => {
    const device = await kidsPhone(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    if (device.heldAt === null) return c.json({ error: "It isn't waiting for anyone" }, 409);
    await release(device);
    await auditPhone(env, c, device, "phone.firmware.allow", {
      to: device.build ? buildLabel(device.build) : "",
    });
    return c.json({ ok: true });
  });
}
