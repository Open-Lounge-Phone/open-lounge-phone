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
  HOST_RE,
  KnockBody,
  Note,
  type Party,
  parseAddress,
  RemoveBody,
  WELL_KNOWN_PATH,
} from "@openloungephone/federation";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
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

/** Someone, as seen by this server: `host` is '' for a local account. */
export interface PeerRef extends Party {
  host: string;
}

const partyOf = (a: Account): Party => ({ handle: a.handle, id: a.id, name: a.name });

/** What the companion sees. */
export function connectionView(c: Connection, host: string) {
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
  };
}

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
      connections: rows
        .filter((r) => r.peerHandle !== WHOLE_SERVER)
        .map((r) => connectionView(r, host)),
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
        { status: r.status, connection: connectionView(r.connection, ownHost(env, c.req.url)) },
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
          return c.json(connectionView(done, ownHost(env, c.req.url)));
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

  return app;
}
