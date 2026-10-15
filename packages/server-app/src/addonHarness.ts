// Test helpers for add-ons (not exported from the package): linking and connecting one over the
// raw device protocol, and `HostileAddon`, an add-on that holds a valid key and does what a good
// bridge never would (any message, malformed JSON, floods, forged ids). The threat model it
// exercises is in docs/security-model.md (Add-ons); the tests are addons.test.ts and
// addonThreats.test.ts.
import { type DeviceToServer, fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { expect, vi } from "vitest";
import { expectStatus, type FakeConn, hello, newKey, type TestServer } from "./testkit.ts";

export type Person = Awaited<ReturnType<TestServer["person"]>>;
export type Key = Awaited<ReturnType<typeof newKey>>;

export const addonHello = (deviceId?: string) => ({
  ...hello(deviceId),
  model: "addon",
  fw: "olp-addon/test",
  buttons: 1,
  display: "none",
});

/** An add-on asks for a code: answers the code (and its socket, waiting for `pair.done`). */
export async function addonCode(s: TestServer, key: Key) {
  const conn = s.openDevice();
  conn.write(addonHello());
  conn.write({ t: "pair.begin", kind: "addon", publicKey: key.publicKey });
  const { code } = await conn.next("pair.code");
  return { conn, code };
}

/** Connects a linked add-on (the signed challenge); answers its socket after `config`. */
export async function connectAddon(s: TestServer, id: string, key: Key) {
  const conn = s.openDevice();
  conn.write(addonHello(id));
  const { nonce } = await conn.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", key.pair.privateKey, fromBase64Url(nonce));
  conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  await conn.next("config");
  return conn;
}

/** Links an add-on `name` to `owner`'s account and connects it. */
export async function linkAddon(s: TestServer, owner: Person, name = "seat", allow: string[] = []) {
  const key = await newKey();
  const { conn: waiting, code } = await addonCode(s, key);
  const res = await s.http("/addons/link", { token: owner.token, body: { code, name, allow } });
  expectStatus(res, 201);
  const done = await waiting.next("pair.done");
  expect(done.deviceId).toBe(res.json.id);
  const conn = await connectAddon(s, res.json.id, key);
  return { id: res.json.id as string, key, conn, address: res.json.address as string };
}

export type Linked = Awaited<ReturnType<typeof linkAddon>>;

/** `a` knocks on `b`, `b` accepts; returns both sides' connection ids. */
export async function connect(sa: TestServer, a: Person, sb: TestServer, b: Person) {
  expectStatus(await sa.http("/connections", { token: a.token, body: { to: b.address } }), 202);
  const inbox = await sb.http("/connections", { token: b.token });
  const req = inbox.json.connections.find((c: { address: string }) => c.address === a.address);
  expectStatus(
    await sb.http(`/connections/${req.id}/accept`, { method: "POST", token: b.token }),
    200,
  );
  const mine = (await sa.http("/connections", { token: a.token })).json.connections.find(
    (c: { address: string }) => c.address === b.address,
  );
  return { aSide: mine.id as string, bSide: req.id as string };
}

/** Answers and runs offer/answer, so both sides see `active`. */
export async function talk(
  caller: FakeConn,
  callee: FakeConn,
  callerCall: string,
  calleeCall: string,
) {
  callee.write({ t: "call.answer", callId: calleeCall });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId: callerCall, type: "offer", sdp: "v=0 offer" });
  expect(await callee.next("rtc.sdp")).toMatchObject({ type: "offer" });
  callee.write({ t: "rtc.sdp", callId: calleeCall, type: "answer", sdp: "v=0 answer" });
  await caller.nextState("active");
  await callee.nextState("active");
}

export const BOOK_CLUB = { id: "bookclub", label: "Book club" };

/** The add-on says what it offers for sharing; resolves once the server has it. */
export async function declare(
  s: TestServer,
  seat: Pick<Linked, "id" | "conn">,
  shares: { id: string; label: string }[],
) {
  seat.conn.write({ t: "addon.shares", shares });
  await vi.waitFor(async () =>
    expect(await s.store.addons.shares(seat.id)).toEqual(
      shares.filter((x, i) => shares.findIndex((y) => y.id === x.id) === i),
    ),
  );
}

/** The owner gives a share to someone (`conn:<id>` or `user:<id>`). */
export const give = (s: TestServer, owner: Person, addonId: string, share: string, to: string) =>
  s.http(`/addons/${addonId}/shares/${share}/grants`, { token: owner.token, body: { to } });

/** Lets the hub's queue and deferred work settle (messages are handled asynchronously). */
export async function settle(s: TestServer, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.all(s.background.splice(0));
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Everything the server stores, table by table (for "it had no effect" checks). `rate_limits`
 * is left out: counting a refused attempt is the point of a limit, not an effect.
 */
export async function dumpDb(s: TestServer): Promise<Record<string, unknown[]>> {
  const tables = await s.sql.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const out: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    if (name === "rate_limits" || name.startsWith("sqlite_")) continue;
    out[name] = await s.sql.all(`SELECT * FROM "${name}"`);
  }
  return out;
}

/**
 * A linked, connected add-on that does what a well-behaved bridge never would. It holds a real
 * key, so the server's rules are all that stands between it and everyone else.
 */
export class HostileAddon {
  readonly s: TestServer;
  readonly id: string;
  readonly key: Key;
  conn: FakeConn;
  readonly address: string;

  constructor(s: TestServer, linked: Linked) {
    this.s = s;
    this.id = linked.id;
    this.key = linked.key;
    this.conn = linked.conn;
    this.address = linked.address;
  }

  static async link(s: TestServer, owner: Person, name = "evil"): Promise<HostileAddon> {
    return new HostileAddon(s, await linkAddon(s, owner, name));
  }

  /** Any JSON object, whatever its type (no schema on this side). */
  send(msg: Record<string, unknown>): void {
    this.conn.handler.message(JSON.stringify(msg));
  }

  /** Raw text on the socket (malformed JSON, oversized frames…). */
  raw(text: string): void {
    this.conn.handler.message(text);
  }

  /** A message the device protocol defines, sent as is. */
  write(msg: DeviceToServer): void {
    this.conn.write(msg);
  }

  /** Connects again over a new socket (the old one is left as it is). */
  async reconnect(): Promise<FakeConn> {
    this.conn = await connectAddon(this.s, this.id, this.key);
    return this.conn;
  }

  /** Every `error` it was sent so far. */
  errors(): { code: string; message: string }[] {
    return this.conn.all("error") as { code: string; message: string }[];
  }
}
