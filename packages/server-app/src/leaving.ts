// Leaving a server: take your data with you (export), then delete your account. See
// docs/export.md for the export format and docs/privacy.md for what is kept.
import type { Hono } from "hono";
import { z } from "zod";
import { Connections } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { dropVoicemailBlobs } from "./voicemail.ts";

export const EXPORT_FORMAT = "openloungephone-export";
export const EXPORT_VERSION = 1;

const DeleteBody = z.object({ confirm: z.string().trim().toLowerCase() });

export function leavingRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** Everything this server holds about your account, as one JSON document (format v1). */
  api.get("/account/export", async (c) => {
    const account = c.get("account");
    const host = ownHost(env, c.req.url);
    const now = env.now();
    const memberships = await store.listMemberships(account.id);
    const spaces = await Promise.all(
      memberships.map(async ({ user, household }) => {
        const devices = await store.listDevices(household.id);
        const guardian = user.role === "guardian";
        return {
          id: household.id,
          name: household.name,
          type: household.type,
          timeZone: household.timeZone,
          role: user.role,
          nameThere: user.name,
          phones: devices
            .filter((d) => guardian || d.ownerUserId === user.id)
            .map((d) => ({ id: d.id, name: d.name, kind: d.kind, own: d.ownerUserId === user.id })),
          ...(guardian && household.type === "home"
            ? { quietHours: (await store.getSchedule(household.id)).rules }
            : {}),
        };
      }),
    );
    const connections = (await store.connections.list(account.id)).filter(
      (x) => x.state === "active" || x.state === "blocked",
    );
    const document = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date(now).toISOString(),
      server: host,
      account: {
        id: account.id,
        handle: account.handle,
        name: account.name,
        address: `${account.handle}@${host}`,
        createdAt: new Date(account.createdAt).toISOString(),
        sharePresence: account.sharePresence,
      },
      connections: connections
        .filter((x) => x.peerHandle !== "*")
        .map((x) => ({
          address: `${x.peerHandle}@${x.peerHost || host}`,
          peerId: x.peerAccount,
          name: x.peerName,
          state: x.state,
          since: new Date(x.updatedAt).toISOString(),
        })),
      blockedServers: connections.filter((x) => x.peerHandle === "*").map((x) => x.peerHost),
      spaces,
      calls: (await store.callLog(account.id, undefined, 1000)).map((l) => ({
        peer: l.peer,
        peerLabel: l.peerLabel,
        direction: l.direction,
        startedAt: new Date(l.startedAt).toISOString(),
        answered: l.answered,
        durationMs: l.durationMs,
        endReason: l.endReason,
        // The voicemail they left after this call, if any: its audio is in your inbox.
        ...(l.voicemailId
          ? { voicemailId: l.voicemailId, voicemail: `/api/voicemails/${l.voicemailId}/audio` }
          : {}),
      })),
    };
    return c.json(document, 200, {
      "content-disposition": `attachment; filename="${account.handle}@${host}.json"`,
    });
  });

  /**
   * Deletes your account. Spaces where you are the only guardian go with it (their phones are
   * unpaired and their voicemail deleted); in shared spaces only your membership goes. Your
   * connections are told you've left. Your handle stays reserved for 90 days.
   */
  api.delete("/account", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, DeleteBody);
    if (b instanceof Response) return b;
    if (b.confirm !== account.handle) {
      return c.json({ error: "type your handle to confirm" }, 400);
    }
    const now = env.now();
    const service = new Connections(env, live);
    for (const conn of await store.connections.list(account.id)) {
      if (conn.state === "active" || (conn.state === "requested" && conn.direction === "out")) {
        await service.remove(account, conn);
      }
    }
    for (const { user, household } of await store.listMemberships(account.id)) {
      const alone = user.role === "guardian" && (await store.guardianCount(household.id)) === 1;
      if (!alone) {
        await dropVoicemailBlobs(env, { userId: user.id });
        await store.deleteUser(user.id, now);
        continue;
      }
      await dropVoicemailBlobs(env, { householdId: household.id });
      const devices = await store.listDevices(household.id);
      // Its phones wipe themselves (now, or when they next connect).
      await store.recordRemovedDevices(devices, now);
      await store.deleteHousehold(household.id);
      for (const d of devices) await live.forgetDevice(household.id, d.id);
    }
    await dropVoicemailBlobs(env, { accountId: account.id });
    await store.deleteAccount(account.id, now);
    return c.body(null, 204);
  });
}
