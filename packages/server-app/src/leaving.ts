// Leaving a server: take your data with you (export), then delete your account. See
// docs/export.md for the export format and docs/privacy.md for what is kept.
import { ownedSpacesBlockingDelete } from "@openloungephone/core";
import type { Account } from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import { Connections } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { closeAccountApps } from "./sessions.ts";
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
        // A recording of this call (it was announced to everyone), if its space made one.
        ...(l.recordingId
          ? { recordingId: l.recordingId, recording: `/api/recordings/${l.recordingId}/audio` }
          : {}),
      })),
      // Missed calls: rang you and nobody answered, with no message (seenAt: when you cleared
      // them; kept until your history setting removes them).
      missedCalls: (await store.missed.ofAccount(account.id)).map((m) => ({
        peer: m.fromPeer,
        peerLabel: m.fromLabel,
        at: new Date(m.at).toISOString(),
        ...(m.seenAt !== null ? { seenAt: new Date(m.seenAt).toISOString() } : {}),
      })),
      // Public lines' call backs you didn't take (shown on your phones until cleared).
      missedCallbacks: (await store.lines.missedCallbacks(account.id, 100)).map((m) => ({
        line: m.lineAddress,
        name: m.lineName,
        at: new Date(m.at).toISOString(),
      })),
      // Recordings of calls and rooms you were in or recorded (their audio: the paths above).
      recordings: (await store.recordings.forAccount(account.id, 1000)).map((r) => ({
        id: r.id,
        kind: r.kind,
        peerLabel: r.peerLabel,
        startedAt: new Date(r.startedAt).toISOString(),
        durationMs: r.durationMs,
        transcript: r.transcript,
        audio: `/api/recordings/${r.id}/audio`,
      })),
    };
    return c.json(document, 200, {
      "content-disposition": `attachment; filename="${account.handle}@${host}.json"`,
    });
  });

  /**
   * Deletes your account. Spaces you own that other people are in must be handed on first (the
   * answer lists them); spaces you're alone in go with the account (their phones are wiped and
   * their voicemail deleted); elsewhere only your membership goes. Your connections are told
   * you've left, your apps are signed out, and your handle stays reserved for 90 days.
   */
  api.delete("/account", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, DeleteBody);
    if (b instanceof Response) return b;
    if (b.confirm !== account.handle) {
      return c.json({ error: "type your handle to confirm" }, 400);
    }
    const blocking = await spacesToHandOn(env, account.id);
    if (blocking.length > 0) {
      return c.json(
        {
          error: `hand these spaces to someone else first: ${blocking.map((s) => s.name).join(", ")}`,
          code: "owner_must_transfer",
          spaces: blocking,
        },
        409,
      );
    }
    await deleteAccountEverywhere(env, live, account);
    return c.body(null, 204);
  });
}

/** Spaces this account owns that other people are in (handed on before the account can go). */
export async function spacesToHandOn(
  env: ServerEnv,
  accountId: string,
): Promise<{ id: string; name: string; type: string }[]> {
  const spaces = await Promise.all(
    (await env.store.listMemberships(accountId)).map(async ({ user, household }) => ({
      id: household.id,
      name: household.name,
      type: household.type,
      owner: (await env.store.spaceOwnerUser(household.id)) === user.id,
      members: await env.store.memberCount(household.id),
    })),
  );
  return ownedSpacesBlockingDelete(spaces).map(({ id, name, type }) => ({ id, name, type }));
}

/**
 * Deletes a space and everything in it: its phones wipe themselves (now, or when they next
 * connect) and its voicemail audio goes.
 */
export async function deleteSpace(env: ServerEnv, live: Coordinator, householdId: string) {
  const now = env.now();
  await dropVoicemailBlobs(env, { householdId });
  const devices = await env.store.listDevices(householdId);
  await env.store.recordRemovedDevices(devices, now);
  await env.store.deleteHousehold(householdId);
  for (const d of devices) await live.forgetDevice(householdId, d.id);
}

/**
 * Deletes an account (the caller checked it owns no space with other people in it): its
 * connections are told, its apps signed out, spaces it is alone in deleted, its other
 * memberships removed. Also used when someone is removed from their only space.
 */
export async function deleteAccountEverywhere(
  env: ServerEnv,
  live: Coordinator,
  account: Account,
): Promise<void> {
  const { store } = env;
  const now = env.now();
  const service = new Connections(env, live);
  for (const conn of await store.connections.list(account.id)) {
    if (conn.state === "active" || (conn.state === "requested" && conn.direction === "out")) {
      await service.remove(account, conn);
    }
  }
  // Nothing keeps working on an open socket.
  await closeAccountApps(env, live, account.id);
  await store.auth.endSessions(account.id);
  for (const { user, household } of await store.listMemberships(account.id)) {
    const alone = (await store.memberCount(household.id)) === 1;
    if (alone) {
      await deleteSpace(env, live, household.id);
      continue;
    }
    await dropVoicemailBlobs(env, { userId: user.id });
    await store.deleteUser(user.id, now);
    // A Lounge phone they were using forgets them now.
    for (const d of await store.listDevices(household.id)) {
      if (d.kind === "lounge") await live.refreshDevice(household.id, d.id);
    }
  }
  await dropVoicemailBlobs(env, { accountId: account.id });
  await store.deleteAccount(account.id, now);
}
