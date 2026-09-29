// Voicemail tickets. When a call goes unanswered (no answer, declined, busy, quiet hours,
// unavailable, offline), the caller's hub hands the caller a single-use ticket with the
// `call.state ended`. The ticket stands for the dial that was already authorized, so the same
// rules hold for the message: whoever couldn't have called can't leave one. Phones have no HTTP
// session; the ticket is their credential too. Tickets are also how a phone records its greeting.
import { DEFAULT_PROMPTS, GREETING_MAX_MS } from "@openloungephone/core";
import {
  type Account,
  type GreetingKind,
  LOCAL_HOST,
  type VoicemailOwner,
} from "@openloungephone/db";
import { baseUrlFor, type Party } from "@openloungephone/federation";
import type { VoicemailOffer } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { greetingForPeer, receivePersonVoicemail, receiveVoicemail } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { fairUseProblem } from "./fairUse.ts";
import { FederationError, fedFetch, outbound } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import type { Vars } from "./httpUtil.ts";
import {
  depositVoicemail,
  greetingOf,
  greetingResponse,
  MAX_VOICEMAIL_MS,
  type Recording,
  readGreeting,
  readRecording,
  saveGreeting,
} from "./voicemail.ts";

/** Who an unanswered call was for. */
export type VmTarget =
  /** A person in the caller's household (their inbox). */
  | { kind: "user"; userId: string; name: string }
  /** A household phone (its guardians' inbox, "missed" on the phone). */
  | { kind: "device"; deviceId: string; name: string }
  /** A ring group's shared box (team/org spaces): its members hear it. */
  | { kind: "group"; groupId: string; name: string }
  /**
   * Someone in another household or on another server, through a connection of the account in
   * `connectionId`: the person, or one of their phones (`deviceId`). `viaPhone`: a kids' phone
   * called through its guardian's connection.
   */
  | {
      kind: "connection";
      connectionId: string;
      deviceId?: string;
      viaPhone?: string;
      name: string;
    }
  /**
   * Another server (`host`; '' = another household here) offered voicemail with its own ticket:
   * a guest at our Lounge phone called through their own server, or a team/org space there
   * transferred our person's call and nobody answered. Greeting and message are forwarded there.
   */
  | { kind: "relay"; host: string; ticket: string; name: string };

/** Who called, as the callee will see them. */
export interface VmCaller {
  /** The person calling: from their app, or a phone they own or are using. */
  userId?: string;
  /** The phone calling, if any. */
  deviceId?: string;
  /** Whose fair-use allowance the message counts against. */
  payer?: string;
  label: string;
  /** As the callee's call log names the caller (`user:<id>`, `device:<id>`). */
  address: string;
  /**
   * Re-checked when the message arrives: that allow-list entry must still allow this call (a
   * kids' phone calling out, or someone calling a kids' phone).
   */
  check?: { deviceId: string; userId: string; field: "deviceCanCall" | "canCallDevice" };
}

interface VoicemailTicket {
  target: VmTarget;
  from: VmCaller;
  /** When the call started (links the message to the callee's call-log row). */
  since: number;
}

interface GreetingTicket {
  owner: VoicemailOwner;
  kind: GreetingKind;
  deviceId: string;
  householdId: string;
}

const partyOf = (a: Account): Party => ({ handle: a.handle, id: a.id, name: a.name });

/** Mints the offer the caller gets with `call.state ended`. */
export async function issueVoicemailOffer(
  env: ServerEnv,
  target: VmTarget,
  from: VmCaller,
  since: number,
): Promise<VoicemailOffer> {
  const data: VoicemailTicket = { target, from, since };
  const ticket = await env.store.createVoicemailTicket("voicemail", data, env.now());
  return {
    ticket,
    name: target.name.slice(0, 24) || "They",
    maxMs: MAX_VOICEMAIL_MS,
    prompts: [...DEFAULT_PROMPTS],
  };
}

/** Lets a phone record a greeting (see `greeting.begin`). */
export async function issueGreetingTicket(
  env: ServerEnv,
  data: GreetingTicket,
): Promise<{ ticket: string; maxMs: number }> {
  const ticket = await env.store.createVoicemailTicket("greeting", data, env.now());
  return { ticket, maxMs: GREETING_MAX_MS[data.kind] };
}

const noTicket = () => Response.json({ error: "unknown or used ticket" }, { status: 404 });

/** The greeting for a ticket's target (another server's, through the connection). */
async function targetGreeting(env: ServerEnv, t: VmTarget): Promise<Response> {
  const { store } = env;
  if (t.kind === "user") {
    const user = await store.getUser(t.userId);
    return greetingResponse(
      user ? await greetingOf(env, { accountId: user.accountId }) : { kind: "default" },
    );
  }
  if (t.kind === "device") return greetingResponse(await greetingOf(env, { deviceId: t.deviceId }));
  // A ring group has the spoken default greeting, with its name.
  if (t.kind === "group") return greetingResponse({ kind: "default" });
  if (t.kind === "relay") {
    if (t.host === LOCAL_HOST) {
      // Another household here (a transfer between spaces on this server): its own ticket.
      const inner = (await store.peekVoicemailTicket(t.ticket, "voicemail", env.now())) as
        | VoicemailTicket
        | undefined;
      return inner && inner.target.kind !== "relay"
        ? targetGreeting(env, inner.target)
        : greetingResponse({ kind: "default" });
    }
    try {
      const res = await outbound(env)(
        new Request(`${baseUrlFor(t.host)}/api/vm/greeting?ticket=${encodeURIComponent(t.ticket)}`),
      );
      const kind = res.headers.get("olp-greeting");
      if (res.status === 200 && (kind === "name" || kind === "custom")) {
        return greetingResponse({
          kind,
          audio: {
            data: await res.arrayBuffer(),
            contentType: res.headers.get("content-type") ?? "audio/webm",
          },
        });
      }
    } catch (e) {
      env.log("warn", "voicemail: relayed greeting unavailable", { error: String(e) });
    }
    return greetingResponse({ kind: "default" });
  }
  const conn = await store.connections.get(t.connectionId);
  const me = conn && (await store.getAccount(conn.accountId));
  if (conn?.state !== "active" || !me) return greetingResponse({ kind: "default" });
  const to = t.deviceId
    ? { kind: "phone" as const, deviceId: t.deviceId }
    : { kind: "person" as const, handle: conn.peerHandle };
  if (conn.peerHost === LOCAL_HOST) {
    const g = await greetingForPeer(env, { ...partyOf(me), host: LOCAL_HOST }, to);
    return greetingResponse(g ?? { kind: "default" });
  }
  try {
    const res = await fedFetch(env, conn.peerHost, "/greeting", {
      json: { from: partyOf(me), to },
    });
    const kind = res.headers.get("olp-greeting");
    if (res.status !== 200 || (kind !== "name" && kind !== "custom")) {
      return greetingResponse({ kind: "default" });
    }
    return greetingResponse({
      kind,
      audio: {
        data: await res.arrayBuffer(),
        contentType: res.headers.get("content-type") ?? "audio/webm",
      },
    });
  } catch (e) {
    env.log("warn", "voicemail: remote greeting unavailable", { error: String(e) });
    return greetingResponse({ kind: "default" });
  }
}

/** Delivers a message to a ticket's target. Returns an HTTP status. */
async function deliver(
  env: ServerEnv,
  live: Coordinator,
  t: VoicemailTicket,
  rec: Recording,
): Promise<201 | 403 | 404 | 502> {
  const { store } = env;
  const { target, from } = t;
  if (from.check) {
    const entry = await store.getContact(from.check.deviceId, from.check.userId);
    if (!entry?.[from.check.field]) return 403;
  }
  if (target.kind === "relay") {
    if (target.host === LOCAL_HOST) {
      // Another household here offered it: use its ticket up and deliver as it says.
      const inner = (await store.takeVoicemailTicket(target.ticket, "voicemail", env.now())) as
        | VoicemailTicket
        | undefined;
      return inner && inner.target.kind !== "relay" ? deliver(env, live, inner, rec) : 404;
    }
    // The other server checks its own ticket, and delivers as its ticket says.
    if (await store.connections.serverBlocked(target.host)) return 403;
    try {
      const res = await outbound(env)(
        new Request(
          `${baseUrlFor(target.host)}/api/vm/message?ticket=${encodeURIComponent(target.ticket)}&durationMs=${rec.durationMs}`,
          { method: "POST", headers: { "content-type": rec.mime }, body: rec.audio },
        ),
      );
      if (res.status === 201) return 201;
      return res.status === 403 || res.status === 404 ? res.status : 502;
    } catch (e) {
      env.log("warn", "voicemail: relay not delivered", { error: String(e) });
      return 502;
    }
  }
  if (target.kind === "user" || target.kind === "device" || target.kind === "group") {
    const vm = await depositVoicemail(env, live, {
      to:
        target.kind === "user"
          ? { userId: target.userId }
          : target.kind === "group"
            ? { groupId: target.groupId }
            : { deviceId: target.deviceId },
      fromUser: from.userId ?? null,
      fromLabel: from.label,
      fromAddress: from.address,
      since: t.since,
      ...rec,
    });
    return vm ? 201 : 404;
  }
  const conn = await store.connections.get(target.connectionId);
  const me = conn && (await store.getAccount(conn.accountId));
  if (conn?.state !== "active" || !conn.peerAccount || !me) return 403;
  const sender = { ...partyOf(me), host: LOCAL_HOST };
  if (conn.peerHost === LOCAL_HOST) {
    const ok = target.deviceId
      ? await receiveVoicemail(env, live, sender, target.deviceId, rec)
      : await receivePersonVoicemail(env, live, sender, conn.peerHandle, rec, {
          viaPhone: target.viaPhone,
        });
    return ok ? 201 : 403;
  }
  const q = new URLSearchParams({
    to: target.deviceId ?? conn.peerHandle,
    from: me.handle,
    fromId: me.id,
    name: me.name,
    durationMs: String(rec.durationMs),
    ...(target.deviceId ? {} : { kind: "person" }),
    ...(target.viaPhone ? { via: target.viaPhone } : {}),
  });
  try {
    await fedFetch(env, conn.peerHost, `/voicemail?${q}`, {
      body: new Uint8Array(rec.audio),
      contentType: rec.mime,
    });
    return 201;
  } catch (e) {
    env.log("warn", "voicemail: not delivered", { error: String(e) });
    return e instanceof FederationError && e.status === 403 ? 403 : 502;
  }
}

/**
 * `/api/vm/*`: public routes whose credential is a ticket (a phone has no HTTP session). Mounted
 * before the session check.
 */
export function publicVoicemailRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** The greeting to play before the tone: audio (`olp-greeting: name|custom`) or 204. */
  api.get("/vm/greeting", async (c) => {
    const token = c.req.query("ticket") ?? "";
    const t = (await store.peekVoicemailTicket(token, "voicemail", env.now())) as
      | VoicemailTicket
      | undefined;
    return t ? targetGreeting(env, t.target) : noTicket();
  });

  /** Leave the message (raw `audio/*` body, up to two minutes). Uses the ticket up. */
  api.post("/vm/message", async (c) => {
    const token = c.req.query("ticket") ?? "";
    const peek = (await store.peekVoicemailTicket(token, "voicemail", env.now())) as
      | VoicemailTicket
      | undefined;
    if (!peek) return noTicket();
    const rec = await readRecording(c.req.raw, c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    const payer = peek.from.payer;
    const over = await fairUseProblem(env, payer, "voicemail", { bytes: rec.audio.byteLength });
    if (over) return c.json({ error: over }, 429);
    const t = (await store.takeVoicemailTicket(token, "voicemail", env.now())) as
      | VoicemailTicket
      | undefined;
    if (!t) return noTicket();
    const status = await deliver(env, live, t, rec);
    if (status !== 201) return c.json({ error: "couldn't leave the message" }, status);
    if (payer) {
      await store.addUsage(payer, env.now(), {
        voicemails: 1,
        voicemailBytes: rec.audio.byteLength,
      });
    }
    return c.json({ ok: true }, 201);
  });

  /** A phone saves the greeting it just recorded (after `greeting.ticket`). */
  api.post("/vm/greeting", async (c) => {
    const token = c.req.query("ticket") ?? "";
    const peek = (await store.peekVoicemailTicket(token, "greeting", env.now())) as
      | GreetingTicket
      | undefined;
    if (!peek) return noTicket();
    const rec = await readGreeting(c.req.raw, peek.kind, c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    const t = (await store.takeVoicemailTicket(token, "greeting", env.now())) as
      | GreetingTicket
      | undefined;
    if (!t) return noTicket();
    await saveGreeting(env, t.owner, rec);
    await live.refreshDevice(t.householdId, t.deviceId);
    return c.json({ ok: true, kind: t.kind }, 201);
  });
}
