// Connections and knocks (federation F1). A knock is a contact request to `handle@host`; the
// recipient accepts, declines silently, or blocks. Only accounts are knockable — household
// phones (kids' phones) have no address. The same logic serves local and remote knocks: for
// another server, the request travels as a signed `/fed/v1` call and the other server runs the
// receiving half.
import {
  type Account,
  type Connection,
  connectionLive,
  DECLINE_COOLDOWN_MS,
  KNOCK_TTL_MS,
  LOCAL_HOST,
  WHOLE_SERVER,
} from "@openloungephone/db";
import {
  AcceptBody,
  CallBody,
  HOST_RE,
  KnockBody,
  LoungeClaimBody,
  LoungeDialBody,
  LoungeLeaveBody,
  LoungeProgressBody,
  Note,
  Party,
  PhonesBody,
  PresenceBody,
  parseAddress,
  RemoveBody,
  WELL_KNOWN_PATH,
} from "@openloungephone/federation";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { primaryHousehold, receiveGuestDial } from "./fedCalls.ts";
import {
  DAY_MS,
  FederationError,
  fedFetch,
  ownHost,
  verifyFedRequest,
  wellKnownDoc,
} from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";
import { depositVoicemail, MAX_VOICEMAIL_BYTES, readRecording } from "./voicemail.ts";

/** Someone, as seen by this server: `host` is '' for a local account. */
export interface PeerRef extends Party {
  host: string;
}

const partyOf = (a: Account): Party => ({ handle: a.handle, id: a.id, name: a.name });

/** What the companion sees. */
export function connectionView(c: Connection, host: string, now: number) {
  return {
    id: c.id,
    address: `${c.peerHandle}@${c.peerHost || host}`,
    host: c.peerHost || host,
    remote: c.peerHost !== LOCAL_HOST,
    name: c.peerName || c.peerHandle,
    state: c.state,
    direction: c.direction,
    note: c.note,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    // Shared only by people who opted in; older than an hour means "don't know".
    presence: c.presence && c.presence.at > now - PRESENCE_FRESH_MS ? c.presence : null,
  };
}

/** Presence older than this is shown as unknown. */
export const PRESENCE_FRESH_MS = 60 * 60 * 1000;

/** Receiving and sending halves, bound to one server. */
export class Connections {
  private readonly env: ServerEnv;
  private readonly live: Coordinator;

  constructor(env: ServerEnv, live: Coordinator) {
    this.env = env;
    this.live = live;
  }

  private get store() {
    return this.env.store;
  }

  private changed(accountId: string): Promise<void> {
    return this.live.notifyAccount(accountId, { t: "connections.changed" }).catch((e) => {
      this.env.log("warn", "connections: notify failed", { error: String(e) });
    });
  }

  // --- receiving (from a local account, or verified from another server) ---------------

  /**
   * A knock arrives. Whatever happens — unknown handle, blocked, cooling down after a decline,
   * duplicate — the sender learns nothing: the answer is always the same.
   */
  async receiveKnock(from: PeerRef, toHandle: string, note: string | undefined): Promise<void> {
    const now = this.env.now();
    const conns = this.store.connections;
    const recipient = await this.store.accountByHandle(toHandle);
    if (!recipient) return;
    if (from.host === LOCAL_HOST && from.id === recipient.id) return;
    if (await conns.blocked(recipient.id, from.host, from)) return;
    if (
      !(await conns.hit(
        `knock-in:${recipient.id}`,
        DAY_MS,
        limitsOf(this.env).inboxKnocksPerDay,
        now,
      ))
    )
      return;
    const row = await conns.findPeer(recipient.id, from.host, from);
    if (row && connectionLive(row, now)) {
      if (row.state !== "requested") return; // active, declined (cooling down) or blocked
      if (row.direction === "in") return; // one pending knock per pair
      // Both knocked: that's a yes from both sides.
      await conns.setState(row.id, "active", now, {
        expiresAt: null,
        direction: "none",
        peerAccount: from.id,
        peerName: from.name,
      });
      try {
        await this.send({ host: from.host, handle: from.handle }, "accept", partyOf(recipient));
      } catch (e) {
        this.env.log("warn", "connections: accept not delivered", { error: String(e) });
      }
      await this.changed(recipient.id);
      return;
    }
    if (row && row.peerHandle !== from.handle) await conns.delete(row.id);
    await conns.put(
      {
        accountId: recipient.id,
        peerHost: from.host,
        peerHandle: from.handle,
        peerAccount: from.id,
        peerName: from.name,
        state: "requested",
        direction: "in",
        note: note?.trim() || null,
        expiresAt: now + KNOCK_TTL_MS,
      },
      now,
    );
    await this.changed(recipient.id);
  }

  /** `from` accepted a knock that `toHandle` sent them; only a pending knock can be accepted. */
  async receiveAccept(from: PeerRef, toHandle: string): Promise<void> {
    const now = this.env.now();
    const knocker = await this.store.accountByHandle(toHandle);
    if (!knocker) return;
    const row = await this.store.connections.findPeer(knocker.id, from.host, from);
    if (!row || !connectionLive(row, now)) return;
    if (row.state !== "requested" || row.direction !== "out") return;
    await this.store.connections.setState(row.id, "active", now, {
      expiresAt: null,
      direction: "none",
      peerAccount: from.id,
      peerName: from.name,
    });
    await this.changed(knocker.id);
  }

  /** `from` disconnected from, cancelled a knock to, or blocked `toHandle`. */
  async receiveRemove(from: PeerRef, toHandle: string): Promise<void> {
    const account = await this.store.accountByHandle(toHandle);
    if (!account) return;
    const row = await this.store.connections.findPeer(account.id, from.host, from);
    // Your own decline or block stays.
    if (!row || (row.state !== "active" && row.state !== "requested")) return;
    await this.store.connections.delete(row.id);
    await this.changed(account.id);
  }

  // --- sending ----------------------------------------------------------------------------

  /** Delivers to a local account directly, or to another server as a signed request. */
  private async send(
    to: { host: string; handle: string },
    kind: "knock" | "accept" | "remove",
    from: Party,
    note?: string,
  ): Promise<void> {
    if (to.host === LOCAL_HOST) {
      const local = { ...from, host: LOCAL_HOST };
      if (kind === "knock") return this.receiveKnock(local, to.handle, note);
      if (kind === "accept") return this.receiveAccept(local, to.handle);
      return this.receiveRemove(local, to.handle);
    }
    const path =
      kind === "knock"
        ? "/knock"
        : kind === "accept"
          ? "/connections/accept"
          : "/connections/remove";
    await fedFetch(this.env, to.host, path, {
      json: { from, to: to.handle, ...(note ? { note } : {}) },
    });
  }

  /** Best effort: the other side learns eventually or its row simply expires. */
  private async sendQuietly(c: Connection, kind: "accept" | "remove", me: Account) {
    try {
      await this.send({ host: c.peerHost, handle: c.peerHandle }, kind, partyOf(me));
    } catch (e) {
      this.env.log("warn", `connections: ${kind} not delivered`, { error: String(e) });
    }
  }

  /** `me` knocks on `address`. Throws FederationError with a user-facing message. */
  async knock(me: Account, address: string, note: string | undefined, requestUrl: string) {
    const now = this.env.now();
    const conns = this.store.connections;
    const addr = parseAddress(address);
    if (!addr) throw new FederationError(400, "that doesn't look like name@server");
    const local = addr.host === ownHost(this.env, requestUrl);
    const host = local ? LOCAL_HOST : addr.host;
    if (local && addr.handle === me.handle) throw new FederationError(400, "that's you");
    if (!local && (await conns.serverBlocked(addr.host))) {
      throw new FederationError(403, "this server doesn't talk to that server");
    }
    if (await conns.blocked(me.id, host, { id: "", handle: WHOLE_SERVER })) {
      throw new FederationError(409, "you blocked that server");
    }
    const existing = await conns.find(me.id, host, addr.handle);
    if (existing && connectionLive(existing, now)) {
      if (existing.state === "active") throw new FederationError(409, "you're already connected");
      if (existing.state === "blocked") throw new FederationError(409, "you blocked them");
      if (existing.state === "requested" && existing.direction === "out") {
        throw new FederationError(409, "you already knocked; wait for their answer");
      }
      if (existing.state === "requested" && existing.direction === "in") {
        // They knocked first: knocking back is saying yes.
        return { connection: await this.accept(me, existing), status: "connected" as const };
      }
    }
    const perDay = limitsOf(this.env).knocksPerDay;
    if (!(await conns.hit(`knock:${me.id}`, DAY_MS, perDay, now))) {
      throw new FederationError(429, `you can knock ${perDay} times a day`);
    }
    const mine = await conns.put(
      {
        accountId: me.id,
        peerHost: host,
        peerHandle: addr.handle,
        peerAccount: null,
        peerName: "",
        state: "requested",
        direction: "out",
        note: note?.trim() || null,
        expiresAt: now + KNOCK_TTL_MS,
      },
      now,
    );
    try {
      await this.send({ host, handle: addr.handle }, "knock", partyOf(me), note?.trim());
    } catch (e) {
      await conns.delete(mine.id);
      throw e;
    }
    return {
      connection: (await conns.get(mine.id)) as Connection,
      status: "sent" as const,
    };
  }

  async accept(me: Account, c: Connection): Promise<Connection> {
    const now = this.env.now();
    if (c.state !== "requested" || c.direction !== "in" || !connectionLive(c, now)) {
      throw new FederationError(409, "there's no knock to accept");
    }
    await this.store.connections.setState(c.id, "active", now, {
      expiresAt: null,
      direction: "none",
    });
    await this.sendQuietly(c, "accept", me);
    return (await this.store.connections.get(c.id)) as Connection;
  }

  async decline(c: Connection): Promise<void> {
    if (c.state !== "requested" || c.direction !== "in") {
      throw new FederationError(409, "there's no knock to decline");
    }
    // Silent: they aren't told; their knock just expires. They can't knock again for 30 days.
    await this.store.connections.setState(c.id, "declined", this.env.now(), {
      expiresAt: this.env.now() + DECLINE_COOLDOWN_MS,
      direction: "none",
    });
  }

  async block(me: Account, c: Connection): Promise<void> {
    const wasShared = c.state === "active" || (c.state === "requested" && c.direction === "out");
    await this.store.connections.setState(c.id, "blocked", this.env.now(), {
      expiresAt: null,
      direction: "none",
    });
    if (wasShared) await this.sendQuietly(c, "remove", me);
  }

  /** Disconnect, cancel a knock, forget a request, or unblock. */
  async remove(me: Account, c: Connection): Promise<void> {
    const wasShared = c.state === "active" || (c.state === "requested" && c.direction === "out");
    await this.store.connections.delete(c.id);
    if (wasShared) await this.sendQuietly(c, "remove", me);
  }

  async blockServer(me: Account, host: string, requestUrl: string): Promise<void> {
    if (!HOST_RE.test(host) || host === ownHost(this.env, requestUrl)) {
      throw new FederationError(400, "not another server");
    }
    const now = this.env.now();
    await this.store.connections.put(
      {
        accountId: me.id,
        peerHost: host,
        peerHandle: WHOLE_SERVER,
        peerAccount: null,
        peerName: host,
        state: "blocked",
        direction: "none",
        note: null,
        expiresAt: null,
      },
      now,
    );
  }

  // --- phones shared with a connection ----------------------------------------------------

  /**
   * Tells a connection's person which of our phones they may call (a guardian here put them on
   * those phones' allow-lists). Sent whenever that list may have changed.
   */
  async sharePhones(connectionId: string): Promise<void> {
    const c = await this.store.connections.get(connectionId);
    if (c?.state !== "active") return;
    const me = await this.store.getAccount(c.accountId);
    if (!me) return;
    const phones = await this.store.sharedPhones(c.id);
    try {
      if (c.peerHost === LOCAL_HOST) {
        await this.receivePhones({ ...partyOf(me), host: LOCAL_HOST }, c.peerHandle, phones);
      } else {
        await fedFetch(this.env, c.peerHost, "/phones", {
          json: { from: partyOf(me), to: c.peerHandle, phones },
        });
      }
    } catch (e) {
      this.env.log("warn", "connections: phones not shared", { error: String(e) });
    }
  }

  async receivePhones(
    from: PeerRef,
    toHandle: string,
    phones: { id: string; label: string }[],
  ): Promise<void> {
    const account = await this.store.accountByHandle(toHandle);
    if (!account) return;
    const row = await this.store.connections.findPeer(account.id, from.host, from);
    if (row?.state !== "active" || row.peerAccount !== from.id) return;
    await this.store.connections.setPhones(row.id, phones);
    await this.changed(account.id);
  }

  // --- presence (opt-in) ------------------------------------------------------------------------

  /**
   * An account's availability changed: tell its connections, if it shares availability. Batched
   * per server (one request each), and rate-limited per account.
   */
  async publishPresence(accountId: string, online: boolean, available: boolean): Promise<void> {
    const account = await this.store.getAccount(accountId);
    if (!account?.sharePresence) return;
    const now = this.env.now();
    if (!(await this.store.connections.hit(`presence:${accountId}`, 10_000, 5, now))) return;
    const byHost = new Map<string, string[]>();
    for (const c of await this.store.connections.list(accountId)) {
      if (c.state !== "active" || !c.peerAccount) continue;
      byHost.set(c.peerHost, [...(byHost.get(c.peerHost) ?? []), c.peerHandle]);
    }
    const from = partyOf(account);
    for (const [host, handles] of byHost) {
      try {
        if (host === LOCAL_HOST) {
          await this.receivePresence({ ...from, host }, handles, online, available);
        } else {
          await fedFetch(this.env, host, "/presence", {
            json: { from, to: handles.slice(0, 200), online, available },
          });
        }
      } catch (e) {
        this.env.log("warn", "connections: presence not delivered", { host, error: String(e) });
      }
    }
  }

  async receivePresence(
    from: PeerRef,
    toHandles: string[],
    online: boolean,
    available: boolean,
  ): Promise<void> {
    const now = this.env.now();
    for (const handle of toHandles) {
      const account = await this.store.accountByHandle(handle);
      if (!account) continue;
      const row = await this.store.connections.findPeer(account.id, from.host, from);
      if (row?.state !== "active" || row.peerAccount !== from.id) continue;
      await this.store.connections.setPresence(row.id, { online, available }, now);
      await this.changed(account.id);
    }
  }
}

const KnockRequest = z.object({ to: z.string().trim().min(3).max(300), note: Note.optional() });
const BlockServerRequest = z.object({ host: z.string().trim().toLowerCase().min(1).max(260) });

function fail(e: unknown): Response {
  if (e instanceof FederationError) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  throw e;
}

/** `/api/connections…` for the signed-in account (any space). */
export function connectionRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;
  const service = new Connections(env, live);

  /** One of the caller's own rows, or undefined. */
  const own = async (accountId: string, id: string) => {
    const c = await store.connections.get(id);
    return c && c.accountId === accountId ? c : undefined;
  };

  api.get("/connections", async (c) => {
    const account = c.get("account");
    const host = ownHost(env, c.req.url);
    const now = env.now();
    const rows = (await store.connections.list(account.id)).filter(
      (r) => connectionLive(r, now) && r.state !== "declined",
    );
    return c.json({
      address: `${account.handle}@${host}`,
      federates: !!env.federationKey && !!env.publicUrl,
      connections: await Promise.all(
        rows
          .filter((r) => r.peerHandle !== WHOLE_SERVER)
          .map(async (r) => ({
            ...connectionView(r, host, now),
            // Their household phones you may call.
            phones: r.state === "active" ? await store.connections.phones(r.id) : [],
          })),
      ),
      sharePresence: account.sharePresence,
      blockedServers: rows
        .filter((r) => r.peerHandle === WHOLE_SERVER)
        .map((r) => ({ id: r.id, host: r.peerHost })),
    });
  });

  api.post("/connections", async (c) => {
    const b = await body(c.req.raw, KnockRequest);
    if (b instanceof Response) return b;
    try {
      const r = await service.knock(c.get("account"), b.to, b.note, c.req.url);
      // "sent" looks the same whether or not the handle exists (no enumeration).
      return c.json(
        {
          status: r.status,
          connection: connectionView(r.connection, ownHost(env, c.req.url), env.now()),
        },
        r.status === "sent" ? 202 : 200,
      );
    } catch (e) {
      return fail(e);
    }
  });

  const act = (name: "accept" | "decline" | "block") =>
    api.post(`/connections/:id/${name}`, async (c) => {
      const account = c.get("account");
      const row = await own(account.id, c.req.param("id"));
      if (!row) return c.json({ error: "not found" }, 404);
      try {
        if (name === "accept") {
          const done = await service.accept(account, row);
          return c.json(connectionView(done, ownHost(env, c.req.url), env.now()));
        }
        if (name === "decline") await service.decline(row);
        else await service.block(account, row);
        return c.body(null, 204);
      } catch (e) {
        return fail(e);
      }
    });
  act("accept");
  act("decline");
  act("block");

  api.delete("/connections/:id", async (c) => {
    const account = c.get("account");
    const row = await own(account.id, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404);
    await service.remove(account, row);
    return c.body(null, 204);
  });

  /**
   * Leave a voicemail on a phone a connection shared (when the call went to voicemail, e.g.
   * during its quiet hours). Delivered to that phone's server, which checks its allow-list.
   */
  api.post("/connections/:id/voicemail", async (c) => {
    const account = c.get("account");
    const row = await own(account.id, c.req.param("id"));
    const deviceId = c.req.query("deviceId") ?? "";
    const phones = row?.state === "active" ? await store.connections.phones(row.id) : [];
    if (!row || !phones.some((p) => p.deviceId === deviceId)) {
      return c.json({ error: "not found" }, 404);
    }
    const rec = await readRecording(c.req.raw, c.req.query("durationMs"));
    if (rec instanceof Response) return rec;
    const from = partyOf(account);
    if (row.peerHost === LOCAL_HOST) {
      const ok = await receiveVoicemail(env, live, { ...from, host: LOCAL_HOST }, deviceId, rec);
      return ok ? c.json({ ok: true }, 201) : c.json({ error: "not allowed" }, 403);
    }
    const q = new URLSearchParams({
      to: deviceId,
      from: from.handle,
      fromId: from.id,
      name: from.name,
      durationMs: String(rec.durationMs),
    });
    try {
      await fedFetch(env, row.peerHost, `/voicemail?${q}`, {
        body: new Uint8Array(rec.audio),
        contentType: rec.mime,
      });
      return c.json({ ok: true }, 201);
    } catch (e) {
      return fail(e);
    }
  });

  api.post("/connections/block-server", async (c) => {
    const b = await body(c.req.raw, BlockServerRequest);
    if (b instanceof Response) return b;
    try {
      await service.blockServer(c.get("account"), b.host, c.req.url);
      return c.body(null, 204);
    } catch (e) {
      return fail(e);
    }
  });
}

/**
 * The public face of federation, mounted at the site root: `/.well-known/openloungephone` and the
 * signed `/fed/v1` endpoints for knocks.
 */
export function federationApp(env: ServerEnv, live: Coordinator): Hono {
  const app = new Hono();
  const service = new Connections(env, live);

  app.get(WELL_KNOWN_PATH, async (c) => {
    const doc = await wellKnownDoc(env);
    if (!doc) return c.json({ error: "this server doesn't federate" }, 404);
    return c.json(doc, 200, { "cache-control": "public, max-age=300" });
  });

  /** Verified JSON body of a `/fed/v1` request, with the sending server's host. */
  const signed = async <S extends z.ZodType>(req: Request, schema: S) => {
    const v = await verifyFedRequest(env, req);
    if (!v.ok) return v.response;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(v.body));
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
    return { host: v.host, body: parsed.data as z.infer<S> };
  };
  const accepted = () => Response.json({ ok: true }, { status: 202 });

  app.post("/fed/v1/knock", async (c) => {
    const r = await signed(c.req.raw, KnockBody);
    if (r instanceof Response) return r;
    if (
      !(await env.store.connections.hit(
        `fedknock:${r.host}`,
        DAY_MS,
        limitsOf(env).fedKnocksPerDay,
        env.now(),
      ))
    ) {
      return c.json({ error: "slow down" }, 429, { "retry-after": "3600" });
    }
    await service.receiveKnock({ ...r.body.from, host: r.host }, r.body.to, r.body.note);
    return accepted();
  });

  app.post("/fed/v1/connections/accept", async (c) => {
    const r = await signed(c.req.raw, AcceptBody);
    if (r instanceof Response) return r;
    await service.receiveAccept({ ...r.body.from, host: r.host }, r.body.to);
    return accepted();
  });

  app.post("/fed/v1/connections/remove", async (c) => {
    const r = await signed(c.req.raw, RemoveBody);
    if (r instanceof Response) return r;
    await service.receiveRemove({ ...r.body.from, host: r.host }, r.body.to);
    return accepted();
  });

  /** A call for someone here. The answer is ringing, or a reason (decided here alone). */
  app.post("/fed/v1/calls", async (c) => {
    const r = await signed(c.req.raw, CallBody);
    if (r instanceof Response) return r;
    if (!env.calls) return c.json({ state: "ended", reason: "unreachable" });
    const result = await env.calls.receive(r.host, r.body);
    return c.json(result.state === "ringing" ? { state: "ringing" } : result);
  });

  app.post("/fed/v1/phones", async (c) => {
    const r = await signed(c.req.raw, PhonesBody);
    if (r instanceof Response) return r;
    await service.receivePhones({ ...r.body.from, host: r.host }, r.body.to, r.body.phones);
    return accepted();
  });

  app.post("/fed/v1/presence", async (c) => {
    const r = await signed(c.req.raw, PresenceBody);
    if (r instanceof Response) return r;
    const { from, to, online, available } = r.body;
    await service.receivePresence({ ...from, host: r.host }, to, online, available);
    return accepted();
  });

  // --- Lounge guests (see HouseholdHub.guestClaim) ----------------------------------------

  /** Another server vouches for its account at one of our Lounge phones (a signed request). */
  app.post("/fed/v1/lounge/claim", async (c) => {
    const r = await signed(c.req.raw, LoungeClaimBody);
    if (r instanceof Response) return r;
    const device = await env.store.getDevice(r.body.deviceId);
    if (device?.kind !== "lounge") return c.json({ step: "failed", reason: "not_found" });
    const { from, directory } = r.body;
    const result = await live.guestClaim(device.householdId, device.id, r.body.nonce, {
      host: r.host,
      handle: from.handle,
      id: from.id,
      name: from.name,
      directory,
    });
    return c.json(result);
  });

  app.post("/fed/v1/lounge/leave", async (c) => {
    const r = await signed(c.req.raw, LoungeLeaveBody);
    if (r instanceof Response) return r;
    const device = await env.store.getDevice(r.body.deviceId);
    if (device?.kind === "lounge") {
      await live.guestLeave(device.householdId, device.id, r.host, r.body.from.id);
    }
    return accepted();
  });

  /** Our account's takeover of the sending server's Lounge phone moved on. */
  app.post("/fed/v1/lounge/progress", async (c) => {
    const r = await signed(c.req.raw, LoungeProgressBody);
    if (r instanceof Response) return r;
    const { to, deviceId, step, reason, expiresAt } = r.body;
    const account = await env.store.accountByHandle(to);
    const state = account && (await env.store.loungeAwayState(account.id, r.host, deviceId));
    if (!account || !state || state === "ended") return accepted();
    if (step === "started" || step === "failed" || step === "ended") {
      await env.store.setLoungeAway(
        account.id,
        r.host,
        deviceId,
        step === "started" ? "active" : "ended",
        env.now(),
      );
    }
    const known = [
      "expired",
      "wrong_key",
      "timeout",
      "busy",
      "not_found",
      "logout",
      "left",
      "idle",
      "replaced",
      "removed",
      "offline",
    ];
    await live.notifyAccount(account.id, {
      t: "lounge.progress",
      deviceId,
      step,
      host: r.host,
      ...(reason && known.includes(reason) ? { reason: reason as "expired" } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    });
    return accepted();
  });

  /** A guest of the sending server's Lounge phone (our account) pressed a key there. */
  app.post("/fed/v1/lounge/dial", async (c) => {
    const r = await signed(c.req.raw, LoungeDialBody);
    if (r instanceof Response) return r;
    return c.json(await receiveGuestDial(env, live, r.host, r.body));
  });

  /** A voicemail for a phone here, from someone on its allow-list (raw audio body). */
  app.post("/fed/v1/voicemail", async (c) => {
    const v = await verifyFedRequest(env, c.req.raw.clone(), MAX_VOICEMAIL_BYTES);
    if (!v.ok) return v.response;
    const q = new URL(c.req.url).searchParams;
    const from = Party.safeParse({
      handle: q.get("from"),
      id: q.get("fromId"),
      name: q.get("name"),
    });
    if (!from.success) return c.json({ error: "invalid sender" }, 400);
    const rec = await readRecording(c.req.raw, q.get("durationMs") ?? undefined);
    if (rec instanceof Response) return rec;
    const ok = await receiveVoicemail(
      env,
      live,
      { ...from.data, host: v.host },
      q.get("to") ?? "",
      rec,
    );
    return ok ? c.json({ ok: true }, 201) : c.json({ error: "not allowed" }, 403);
  });

  return app;
}

/**
 * Stores a voicemail from someone elsewhere for a phone here, if its allow-list lets them call it
 * (through an active connection).
 */
export async function receiveVoicemail(
  env: ServerEnv,
  live: Coordinator,
  from: PeerRef,
  deviceId: string,
  rec: { mime: string; audio: ArrayBuffer; durationMs: number },
): Promise<boolean> {
  const device = await env.store.getDevice(deviceId);
  if (!device) return false;
  const entry = (await env.store.listRemoteContacts(device.id)).find(
    (r) => r.connection.peerHost === from.host && r.connection.peerAccount === from.id,
  );
  if (!entry?.canCallDevice) return false;
  await depositVoicemail(env, live, { device, fromUser: null, fromLabel: entry.label, ...rec });
  return true;
}

/**
 * The `ServerEnv.onPresence` hook: a member's presence changed in a household hub. Presence is
 * shared from the account's first (personal) space, where federated calls ring.
 */
export function presenceHook(
  env: ServerEnv,
  live: Coordinator,
): NonNullable<ServerEnv["onPresence"]> {
  const service = new Connections(env, live);
  return (householdId, userId, online, available) => {
    env.defer(
      (async () => {
        const user = await env.store.getUser(userId);
        if (!user) return;
        const home = await primaryHousehold(env, user.accountId);
        if (home?.household.id !== householdId) return;
        await service.publishPresence(user.accountId, online, available);
      })().catch((e) => env.log("warn", "presence publish failed", { error: String(e) })),
    );
  };
}
