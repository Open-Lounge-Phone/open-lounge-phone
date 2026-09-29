// The buddy timeline (P2b): one history per connection — calls (when, how long, which way,
// answered or missed) and the voicemails they left you, with transcripts. There is no text chat.
// History expires per connection, else by the account default, else by the server default
// (keep); a sweep deletes expired rows and their audio.
import {
  type Account,
  type CallLogEntry,
  type Connection,
  LOCAL_HOST,
  RETENTION_DAYS,
  type Retention,
  retentionName,
  type Voicemail,
  WHOLE_SERVER,
} from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import { connectionView } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import { body, type Vars } from "./httpUtil.ts";

export const RetentionChoice = z.enum(["default", "30d", "1y", "forever"]);
const RetentionBody = z.object({ retention: RetentionChoice });

/** Days for a choice; null = "default" (inherit). */
export const retentionDays = (choice: z.infer<typeof RetentionChoice>): number | null =>
  choice === "default" ? null : RETENTION_DAYS[choice];

/** Where a person's history with a connection gets its retention, and what it is. */
export function effectiveRetention(
  connection: Pick<Connection, "retentionDays">,
  account: Pick<Account, "retentionDays">,
  /** The space's default for history (null = forever). */
  space: number | null = null,
): { effective: Retention; from: "connection" | "account" | "space" | "server" } {
  const [days, from] =
    connection.retentionDays !== null
      ? [connection.retentionDays, "connection" as const]
      : account.retentionDays !== null
        ? [account.retentionDays, "account" as const]
        : space !== null
          ? [space, "space" as const]
          : [0, "server" as const];
  return { effective: retentionName(days) as Retention, from };
}

/**
 * The names a person goes by in call logs and voicemail: their address, and for someone on this
 * server also their memberships (`user:<id>`) from calls inside a shared space.
 */
export async function peerAddresses(
  env: ServerEnv,
  connection: Connection,
  host: string,
): Promise<string[]> {
  const out = [`${connection.peerHandle}@${connection.peerHost || host}`];
  if (connection.peerHost === LOCAL_HOST && connection.peerAccount) {
    for (const m of await env.store.listMemberships(connection.peerAccount)) {
      out.push(`user:${m.user.id}`);
    }
  }
  return out;
}

const voicemailView = (v: Voicemail) => ({
  id: v.id,
  at: v.createdAt,
  fromLabel: v.fromLabel,
  durationMs: v.durationMs,
  transcript: v.transcript,
  transcriptStatus: v.transcriptStatus,
  heardAt: v.heardAt,
});

export type TimelineItem =
  | {
      kind: "call";
      id: string;
      at: number;
      direction: "in" | "out";
      answered: boolean;
      durationMs: number;
      endReason: string | null;
      voicemail: ReturnType<typeof voicemailView> | null;
    }
  | { kind: "voicemail"; id: string; at: number; voicemail: ReturnType<typeof voicemailView> };

/** Calls and voicemails, newest first; a voicemail left after a missed call sits on that call. */
export function buildTimeline(calls: CallLogEntry[], voicemails: Voicemail[]): TimelineItem[] {
  const byId = new Map(voicemails.map((v) => [v.id, v]));
  const used = new Set<string>();
  const items: TimelineItem[] = calls.map((c) => {
    const vm = c.voicemailId ? byId.get(c.voicemailId) : undefined;
    if (vm) used.add(vm.id);
    return {
      kind: "call",
      id: c.id ?? "",
      at: c.startedAt,
      direction: c.direction,
      answered: c.answered,
      durationMs: c.durationMs,
      endReason: c.endReason,
      voicemail: vm ? voicemailView(vm) : null,
    };
  });
  for (const v of voicemails) {
    if (!used.has(v.id))
      items.push({ kind: "voicemail", id: v.id, at: v.createdAt, voicemail: voicemailView(v) });
  }
  return items.sort((a, b) => b.at - a.at);
}

// --- expiry ----------------------------------------------------------------------------

/** Deletes a space's expired history and its audio. */
export async function sweepSpace(env: ServerEnv, householdId: string): Promise<void> {
  const { blobs } = await env.store.sweepExpired(householdId, ownHost(env), env.now());
  for (const key of blobs) await env.blobs.delete(key);
}

/** Sweeps every space an account is in (before showing it history). */
export async function sweepAccount(env: ServerEnv, accountId: string): Promise<void> {
  for (const m of await env.store.listMemberships(accountId)) await sweepSpace(env, m.household.id);
}

/** A space's hub sweeps at most this often, on activity (never on a timer of its own). */
export const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

// --- routes ------------------------------------------------------------------------------

export function timelineRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  const own = async (account: Account, id: string) => {
    const c = await store.connections.get(id);
    return c && c.accountId === account.id && c.peerHandle !== WHOLE_SERVER ? c : undefined;
  };

  /** Your history with one connection: calls and the voicemails they left you. */
  api.get("/connections/:id/timeline", async (c) => {
    const account = c.get("account");
    const connection = await own(account, c.req.param("id"));
    if (!connection) return c.json({ error: "not found" }, 404);
    await sweepAccount(env, account.id);
    const host = ownHost(env, c.req.url);
    const peers = await peerAddresses(env, connection, host);
    const [calls, voicemails] = await Promise.all([
      store.callLogWith(account.id, peers),
      store.personalVoicemailsFrom(account.id, peers),
    ]);
    // The active space's default applies when neither you nor the connection set one.
    const member = c.get("member");
    const space = member ? (await store.spacePrivacy(member.householdId)).historyDays : null;
    return c.json({
      connection: connectionView(connection, host, env.now()),
      retention: {
        setting: retentionName(connection.retentionDays),
        account: retentionName(account.retentionDays),
        ...effectiveRetention(connection, account, space),
      },
      items: buildTimeline(calls, voicemails),
    });
  });

  /** How long your history with this connection is kept ("default" = your account default). */
  api.put("/connections/:id/retention", async (c) => {
    const account = c.get("account");
    const connection = await own(account, c.req.param("id"));
    if (!connection) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, RetentionBody);
    if (b instanceof Response) return b;
    await store.connections.setRetention(connection.id, retentionDays(b.retention));
    await sweepAccount(env, account.id);
    return c.body(null, 204);
  });

  /** Your default for how long history with connections is kept. */
  api.get("/account/retention", (c) =>
    c.json({ retention: retentionName(c.get("account").retentionDays) }),
  );

  api.put("/account/retention", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, RetentionBody);
    if (b instanceof Response) return b;
    await store.setAccountRetention(account.id, retentionDays(b.retention));
    await sweepAccount(env, account.id);
    return c.body(null, 204);
  });
}
