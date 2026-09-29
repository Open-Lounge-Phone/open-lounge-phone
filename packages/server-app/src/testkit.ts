// Test helpers shared by the server-app suites (not exported from the package). One
// `TestServer` is one in-memory server; several can be wired together for federation tests.
import { Store, type User } from "@openloungephone/db";
import { migrate, openSqlite } from "@openloungephone/db/node";
import { generateServerKey } from "@openloungephone/federation";
import {
  encode,
  fromBase64Url,
  type ServerToApp,
  type ServerToDevice,
  toBase64Url,
} from "@openloungephone/protocol";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import { federationApp, presenceHook } from "./connections.ts";
import type { Conn, ConnMemo, RoomSnapshot, ServerEnv } from "./env.ts";
import { FedCalls } from "./fedCalls.ts";
import { type Dialer, LinkRegistry } from "./fedLinks.ts";
import type { LinkSocket } from "./fedStream.ts";
import { type ConnectionHandler, Gateway } from "./gateway.ts";
import { createApi } from "./http.ts";

export type Msg = ServerToDevice | ServerToApp;

// Monday 2026-03-02 12:00 UTC.
export const NOON_MONDAY = Date.UTC(2026, 2, 2, 12);

export class FakeConn implements Conn {
  sent: Msg[] = [];
  closed?: { code: number; reason: string };
  memo?: ConnMemo;
  private cursor = 0;
  handler!: ConnectionHandler;

  remember(memo: ConnMemo) {
    this.memo = structuredClone(memo);
  }
  send(msg: Msg) {
    this.sent.push(structuredClone(msg));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.handler.closed();
  }
  write<T extends { t: string }>(msg: T) {
    this.handler.message(encode(msg));
  }
  /** Waits for the next message of type `t` after the ones already consumed. */
  async next<T extends Msg["t"]>(t: T): Promise<Extract<Msg, { t: T }>> {
    return vi.waitFor(() => {
      const i = this.sent.findIndex((m, idx) => idx >= this.cursor && m.t === t);
      if (i < 0) {
        throw new Error(`no ${t} yet; sent: ${JSON.stringify(this.sent.slice(this.cursor))}`);
      }
      this.cursor = i + 1;
      return this.sent[i] as Extract<Msg, { t: T }>;
    });
  }
  async nextState(state: string) {
    for (;;) {
      const m = await this.next("call.state");
      if (m.state === state) return m;
    }
  }
  /** Messages of type `t` sent so far (consumed or not). */
  all<T extends Msg["t"]>(t: T): Extract<Msg, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<Msg, { t: T }>[];
  }
}

/** A shared fake clock; several servers in one test share one. */
export class ManualTimers {
  now = NOON_MONDAY;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  set = (fn: () => void, ms: number) => {
    const t = { at: this.now + ms, fn, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  };
  pending() {
    return this.timers.filter((t) => t.live).length;
  }
  advance(ms: number) {
    this.now += ms;
    for (const t of this.timers.filter((t) => t.live && t.at <= this.now)) {
      t.live = false;
      t.fn();
    }
  }
}

export interface HttpInit {
  method?: string;
  token?: string;
  body?: unknown;
  raw?: BodyInit;
  type?: string;
  household?: string;
  headers?: Record<string, string>;
}

export class TestServer {
  readonly store: Store;
  readonly env: ServerEnv;
  readonly gateway: Gateway;
  readonly api: ReturnType<typeof createApi>;
  /** Everything a real host serves: `/api`, `/.well-known`, `/fed/v1`. */
  readonly root: Hono;
  readonly blobs = new Map<string, { data: ArrayBuffer; contentType: string }>();
  readonly background: Promise<unknown>[] = [];
  readonly savedRooms = new Map<string, RoomSnapshot[]>();
  readonly timers: ManualTimers;
  /** Server-pair streams (federated calls). */
  readonly links: LinkRegistry;

  constructor(
    opts: {
      timers?: ManualTimers;
      publicUrl?: string;
      env?: Partial<ServerEnv>;
      dialer?: Dialer;
    } = {},
  ) {
    const { sql, db } = openSqlite(":memory:");
    migrate(db);
    this.store = new Store(sql);
    this.timers = opts.timers ?? new ManualTimers();
    const timers = this.timers;
    this.env = {
      store: this.store,
      now: () => timers.now,
      iceServers: async () => [{ urls: "stun:stun.example:3478" }],
      setTimer: timers.set,
      log: () => {},
      saveRooms: (hh, rooms) => this.savedRooms.set(hh, structuredClone(rooms)),
      blobs: {
        put: async (key, data, contentType) => void this.blobs.set(key, { data, contentType }),
        get: async (key) => this.blobs.get(key),
        delete: async (key) => void this.blobs.delete(key),
      },
      transcriber: { transcribe: async (audio) => `heard ${audio.byteLength} bytes` },
      defer: (work) => void this.background.push(work),
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
      ...opts.env,
    };
    this.gateway = new Gateway(this.env);
    this.api = createApi(this.env, this.gateway);
    const noNetwork: Dialer = async () => {
      throw new Error("no network in this test");
    };
    this.links = new LinkRegistry(this.env, this.gateway, opts.dialer ?? noNetwork);
    this.env.calls = new FedCalls(this.env, this.gateway, this.links);
    this.env.onPresence = presenceHook(this.env, this.gateway);
    this.root = new Hono();
    this.root.route("/api", this.api);
    this.root.route("/", federationApp(this.env, this.gateway));
  }

  /** The host part of addresses on this server. */
  get host(): string {
    return new URL(this.env.publicUrl ?? "http://localhost").host;
  }

  async http(path: string, init: HttpInit = {}) {
    const res = await this.api.request(path, {
      method: init.method ?? (init.body || init.raw ? "POST" : "GET"),
      headers: {
        "content-type": init.type ?? "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.household ? { "x-household": init.household } : {}),
        ...init.headers,
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      ...(init.raw ? { body: init.raw } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text ? JSON.parse(text) : undefined,
      headers: res.headers,
    };
  }

  /**
   * A signed-up grown-up: an account with a handle, their own space, and a session (the passkey
   * ceremony is covered in server.test.ts).
   */
  async person(handle: string, name = handle, type: "home" | "team" | "org" = "home") {
    const now = this.timers.now;
    const account = await this.store.createAccount({ name, handle }, now);
    if (!account) throw new Error(`handle ${handle} taken`);
    const { household, guardian } = await this.store.createHousehold(
      { name: `${name}'s home`, timeZone: "UTC", guardianName: name, accountId: account.id, type },
      now,
    );
    const token = await this.store.createAccountSession(account.id, guardian.id, now);
    return { account, household, user: guardian, token, address: `${handle}@${this.host}` };
  }

  openDevice() {
    const conn = new FakeConn();
    conn.handler = this.gateway.openDevice(conn);
    return conn;
  }

  openApp() {
    const conn = new FakeConn();
    conn.handler = this.gateway.openApp(conn);
    return conn;
  }

  async connectApp(token: string, household?: string) {
    const conn = this.openApp();
    conn.write({ t: "app.hello", proto: 1, token, ...(household ? { household } : {}) });
    await conn.next("app.ready");
    return conn;
  }

  /** Pairs a new phone into the active household of `token`. */
  async pairDevice(
    token: string,
    name = "Kid phone",
    extra: { forMe?: boolean; kind?: "kids" | "lounge" } = {},
  ) {
    const key = await newKey();
    const conn = this.openDevice();
    conn.write(hello());
    conn.write({ t: "pair.begin", publicKey: key.publicKey });
    const { code } = await conn.next("pair.code");
    const res = await this.http("/devices/pair", { token, body: { code, name, ...extra } });
    if (res.status !== 201) return { status: res.status, error: res.json?.error as string };
    const done = await conn.next("pair.done");
    return { status: 201, deviceId: done.deviceId, key };
  }

  async connectDevice(deviceId: string, key: CryptoKeyPair) {
    const conn = this.openDevice();
    conn.write(hello(deviceId));
    const { nonce } = await conn.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", key.privateKey, fromBase64Url(nonce));
    conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    await conn.next("config");
    return conn;
  }
}

/**
 * Servers that reach each other by host name through an in-memory "internet". `down` hosts
 * fail like an unreachable server; `requests` records every server-to-server request.
 */
export class Network {
  readonly timers = new ManualTimers();
  readonly servers = new Map<string, TestServer>();
  readonly down = new Set<string>();
  readonly requests: { from: string | undefined; url: string; status: number }[] = [];
  /** Lets a test rewrite a request in flight (e.g. to replay or tamper with it). */
  tap?: (req: Request) => Request | Promise<Request>;

  async server(host: string, opts: { env?: Partial<ServerEnv> } = {}): Promise<TestServer> {
    const key = await generateServerKey();
    const server = new TestServer({
      timers: this.timers,
      publicUrl: `https://${host}`,
      env: { federationKey: key, fetch: (req) => this.fetch(req), ...opts.env },
      dialer: (url, link) => this.dial(url, link),
    });
    this.servers.set(host, server);
    return server;
  }

  /** Open server-pair sockets (dialer side), for idle-close checks. */
  readonly streams: { from: string; to: string; closed: boolean }[] = [];

  /** An in-memory WebSocket between two servers; frames arrive in order, asynchronously. */
  async dial(url: string, link: import("./fedStream.ts").ServerLink): Promise<LinkSocket> {
    const u = new URL(url);
    const target = this.servers.get(u.host);
    const from = u.searchParams.get("from") ?? "";
    if (!target || this.down.has(u.host)) throw new TypeError(`connect failed: ${u.host}`);
    const record = { from, to: u.host, closed: false };
    let acceptor: import("./fedStream.ts").ServerLink | undefined;
    const later = (fn: () => void) => void Promise.resolve().then(fn);
    const client: LinkSocket = {
      send: (text) => {
        if (!record.closed) later(() => void acceptor?.receive(server, text));
      },
      close: () => {
        if (record.closed) return;
        record.closed = true;
        link.closed(client);
        later(() => acceptor?.closed(server));
      },
    };
    const server: LinkSocket = {
      send: (text) => {
        if (!record.closed) later(() => void link.receive(client, text));
      },
      close: () => {
        if (record.closed) return;
        record.closed = true;
        acceptor?.closed(server);
        later(() => link.closed(client));
      },
    };
    acceptor = target.links.accept(from, server);
    if (!acceptor) throw new TypeError("refused");
    this.streams.push(record);
    return client;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const target = this.servers.get(url.host);
    if (!target || this.down.has(url.host)) throw new TypeError(`fetch failed: ${url.host}`);
    const sent = this.tap ? await this.tap(req.clone()) : req;
    const res = await target.root.fetch(sent);
    const keyid = /keyid="([^"]+)"/.exec(req.headers.get("signature-input") ?? "")?.[1];
    this.requests.push({ from: keyid, url: req.url, status: res.status });
    return res;
  }
}

export const hello = (deviceId?: string) => ({
  t: "hello",
  proto: 1,
  model: "web-emulator",
  fw: "test",
  buttons: 4,
  display: "eink",
  ...(deviceId ? { deviceId } : {}),
});

export async function newKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: toBase64Url(pub) };
}

export function expectStatus(res: { status: number; json?: unknown }, status: number) {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
}

export type { User };
