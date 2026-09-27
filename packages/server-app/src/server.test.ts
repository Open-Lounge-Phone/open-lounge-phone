import { Store, type User } from "@openloungephone/db";
import { migrate, openSqlite } from "@openloungephone/db/node";
import {
  encode,
  fromBase64Url,
  type ServerToApp,
  type ServerToDevice,
  toBase64Url,
} from "@openloungephone/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type Conn,
  type ConnMemo,
  HELLO_TIMEOUT_MS,
  RING_TIMEOUT_MS,
  type RoomSnapshot,
  type ServerEnv,
} from "./env.ts";
import { type ConnectionHandler, Gateway } from "./gateway.ts";
import { createApi, ensureSetupToken } from "./http.ts";

type Msg = ServerToDevice | ServerToApp;

// Monday 2026-03-02 12:00 UTC.
const NOON_MONDAY = Date.UTC(2026, 2, 2, 12);

class FakeConn implements Conn {
  sent: Msg[] = [];
  closed?: { code: number; reason: string };
  memo?: ConnMemo;
  remember(memo: ConnMemo) {
    this.memo = structuredClone(memo);
  }
  private cursor = 0;
  handler!: ConnectionHandler;

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
      if (i < 0)
        throw new Error(`no ${t} yet; sent: ${JSON.stringify(this.sent.slice(this.cursor))}`);
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
}

class ManualTimers {
  now = NOON_MONDAY;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  set = (fn: () => void, ms: number) => {
    const t = { at: this.now + ms, fn, live: true };
    this.timers.push(t);
    return () => {
      t.live = false;
    };
  };
  advance(ms: number) {
    this.now += ms;
    for (const t of this.timers.filter((t) => t.live && t.at <= this.now)) {
      t.live = false;
      t.fn();
    }
  }
}

let store: Store;
let timers: ManualTimers;
let savedRooms: Map<string, RoomSnapshot[]>;
let blobs: Map<string, { data: ArrayBuffer; contentType: string }>;
let background: Promise<unknown>[];
let env: ServerEnv;
let gateway: Gateway;
let api: ReturnType<typeof createApi>;

beforeEach(() => {
  const { sql, db } = openSqlite(":memory:");
  migrate(db);
  store = new Store(sql);
  timers = new ManualTimers();
  env = {
    store,
    now: () => timers.now,
    iceServers: async () => [{ urls: "stun:stun.example:3478" }],
    setTimer: timers.set,
    log: () => {},
    saveRooms: (hh, rooms) => savedRooms.set(hh, structuredClone(rooms)),
    blobs: {
      put: async (key, data, contentType) => void blobs.set(key, { data, contentType }),
      get: async (key) => blobs.get(key),
      delete: async (key) => void blobs.delete(key),
    },
    transcriber: {
      transcribe: async (audio) => `heard ${audio.byteLength} bytes`,
    },
    defer: (work) => void background.push(work),
  };
  blobs = new Map();
  background = [];
  savedRooms = new Map();
  gateway = new Gateway(env);
  api = createApi(env, gateway);
});

async function http(
  path: string,
  init: { method?: string; token?: string; body?: unknown; raw?: BodyInit; type?: string } = {},
) {
  const res = await api.request(path, {
    method: init.method ?? (init.body || init.raw ? "POST" : "GET"),
    headers: {
      "content-type": init.type ?? "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    ...(init.raw ? { body: init.raw } : {}),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function setup(timeZone = "UTC") {
  const setupToken = await ensureSetupToken(env);
  const res = await http("/setup", {
    body: { token: setupToken, householdName: "Home", guardianName: "Mom", timeZone },
  });
  expect(res.status).toBe(201);
  return { token: res.json.token as string, user: res.json.user as User };
}

function openDevice() {
  const conn = new FakeConn();
  conn.handler = gateway.openDevice(conn);
  return conn;
}
function openApp() {
  const conn = new FakeConn();
  conn.handler = gateway.openApp(conn);
  return conn;
}

const hello = (deviceId?: string) => ({
  t: "hello",
  proto: 1,
  model: "web-emulator",
  fw: "test",
  buttons: 4,
  display: "eink",
  ...(deviceId ? { deviceId } : {}),
});

async function newKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { pair, publicKey: toBase64Url(pub) };
}

/** Pairs a new device into the household of `guardianToken`; returns its id and key. */
async function pairDevice(guardianToken: string, name = "Kid phone") {
  const key = await newKey();
  const conn = openDevice();
  conn.write(hello());
  conn.write({ t: "pair.begin", publicKey: key.publicKey });
  const { code } = await conn.next("pair.code");
  const res = await http("/devices/pair", { token: guardianToken, body: { code, name } });
  expect(res.status).toBe(201);
  const done = await conn.next("pair.done");
  return { deviceId: done.deviceId, key };
}

async function connectDevice(deviceId: string, key: CryptoKeyPair) {
  const conn = openDevice();
  conn.write(hello(deviceId));
  const { nonce } = await conn.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", key.privateKey, fromBase64Url(nonce));
  conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  await conn.next("config");
  return conn;
}

async function connectApp(token: string) {
  const conn = openApp();
  conn.write({ t: "app.hello", proto: 1, token });
  await conn.next("app.ready");
  return conn;
}

/** Household with a guardian, a paired + connected device, and a connected guardian app. */
async function household() {
  const g = await setup();
  const { deviceId, key } = await pairDevice(g.token);
  const device = await connectDevice(deviceId, key.pair);
  const app = await connectApp(g.token);
  return { ...g, deviceId, key, device, app };
}

describe("setup", () => {
  it("is single-use", async () => {
    const setupToken = await ensureSetupToken(env);
    const body = { token: setupToken, householdName: "H", guardianName: "G", timeZone: "UTC" };
    expect((await http("/setup", { body })).status).toBe(201);
    expect((await http("/setup", { body })).status).toBe(403);
    expect(await ensureSetupToken(env)).toBeUndefined();
  });

  it("rejects bad time zones and wrong tokens", async () => {
    const setupToken = await ensureSetupToken(env);
    const base = { householdName: "H", guardianName: "G" };
    expect(
      (await http("/setup", { body: { ...base, token: "nope", timeZone: "UTC" } })).status,
    ).toBe(403);
    expect(
      (await http("/setup", { body: { ...base, token: setupToken, timeZone: "Nowhere/X" } }))
        .status,
    ).toBe(400);
  });

  it("requires auth for everything else", async () => {
    expect((await http("/me")).status).toBe(401);
    expect((await http("/me", { token: "bogus" })).status).toBe(401);
  });
});

describe("pairing and device auth", () => {
  it("pairs, then authenticates with a signature and receives config", async () => {
    const g = await setup();
    const { deviceId, key } = await pairDevice(g.token);
    const conn = openDevice();
    conn.write(hello(deviceId));
    const { nonce } = await conn.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", key.pair.privateKey, fromBase64Url(nonce));
    conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    expect(await conn.next("config")).toEqual({
      t: "config",
      buttons: [{ index: 0, label: "Mom" }],
      quiet: false,
    });
  });

  it("rejects a signature from the wrong key", async () => {
    const g = await setup();
    const { deviceId } = await pairDevice(g.token);
    const imposter = await newKey();
    const conn = openDevice();
    conn.write(hello(deviceId));
    const { nonce } = await conn.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", imposter.pair.privateKey, fromBase64Url(nonce));
    conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    await vi.waitFor(() => expect(conn.closed?.code).toBe(CloseCode.unauthorized));
  });

  it("rejects unknown devices, wrong protocol versions, and skipped handshakes", async () => {
    const unknown = openDevice();
    unknown.write(hello("dev_nope"));
    await vi.waitFor(() => expect(unknown.closed?.code).toBe(CloseCode.unauthorized));

    const old = openDevice();
    old.write({ ...hello(), proto: 99 });
    expect((await old.next("error")).code).toBe("unsupported_version");

    const rude = openDevice();
    rude.write({ t: "button", index: 0 });
    await vi.waitFor(() => expect(rude.closed?.code).toBe(CloseCode.badHandshake));
  });

  it("drops sockets that never say hello", async () => {
    const conn = openDevice();
    timers.advance(HELLO_TIMEOUT_MS);
    expect(conn.closed?.code).toBe(CloseCode.timeout);
  });

  it("only guardians can pair, and codes are single use", async () => {
    const g = await setup();
    const kid = await store.createUser(
      { householdId: g.user.householdId, name: "Kid", role: "contact" },
      0,
    );
    const kidToken = await store.createSession(kid.id, timers.now);
    const conn = openDevice();
    conn.write(hello());
    conn.write({ t: "pair.begin", publicKey: (await newKey()).publicKey });
    const { code } = await conn.next("pair.code");
    expect(
      (await http("/devices/pair", { token: kidToken, body: { code, name: "X" } })).status,
    ).toBe(403);
    expect(
      (await http("/devices/pair", { token: g.token, body: { code, name: "X" } })).status,
    ).toBe(201);
    expect(
      (await http("/devices/pair", { token: g.token, body: { code, name: "X" } })).status,
    ).toBe(404);
  });
});

describe("calls", () => {
  it("device calls the guardian: ring, answer, negotiate, talk, hang up", async () => {
    const { device, app } = await household();
    device.write({ t: "hook", state: "up" });
    device.write({ t: "button", index: 0 });

    const ringing = await device.nextState("ringing");
    const incoming = await app.next("call.ringing");
    expect(incoming).toEqual({
      t: "call.ringing",
      callId: ringing.callId,
      from: { label: "Kid phone" },
    });

    app.write({ t: "call.answer", callId: incoming.callId });
    for (const c of [device, app]) {
      expect((await c.next("rtc.config")).iceServers).toEqual([{ urls: "stun:stun.example:3478" }]);
      await c.nextState("connecting");
    }

    // The caller (device) offers; the hub relays both ways and marks the call active on answer.
    const callId = incoming.callId;
    device.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
    expect((await app.next("rtc.sdp")).sdp).toBe("v=0 offer");
    app.write({ t: "rtc.ice", callId, candidate: "candidate:1", sdpMid: "0" });
    expect((await device.next("rtc.ice")).candidate).toBe("candidate:1");
    app.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 answer" });
    expect((await device.next("rtc.sdp")).sdp).toBe("v=0 answer");
    await device.nextState("active");
    await app.nextState("active");

    device.write({ t: "call.hangup", callId });
    expect(await app.nextState("ended")).toMatchObject({ reason: "hangup" });
    expect(await device.nextState("ended")).toMatchObject({ reason: "hangup" });
  });

  it("guardian calls the device and the device answers", async () => {
    const { device, app, deviceId } = await household();
    app.write({ t: "call.dial", deviceId });
    const { callId } = await app.nextState("ringing");
    expect(await device.next("call.ringing")).toEqual({
      t: "call.ringing",
      callId,
      from: { label: "Mom" },
    });
    device.write({ t: "hook", state: "up" });
    device.write({ t: "call.answer", callId });
    await app.nextState("connecting");
    await device.nextState("connecting");
  });

  it("stops ringing on the user's other sessions once one answers", async () => {
    const { device, app, token } = await household();
    const second = await connectApp(token);
    device.write({ t: "button", index: 0 });
    const { callId } = await app.next("call.ringing");
    await second.next("call.ringing");
    app.write({ t: "call.answer", callId });
    expect(await second.nextState("ended")).toMatchObject({ callId });
    // The other session cannot hijack the answered call.
    second.write({ t: "rtc.sdp", callId, type: "offer", sdp: "x" });
    await app.nextState("connecting");
    expect(device.sent.filter((m) => m.t === "rtc.sdp")).toEqual([]);
  });

  it("times out unanswered calls and stalled media", async () => {
    const { device, app } = await household();
    device.write({ t: "button", index: 0 });
    const { callId } = await app.next("call.ringing");
    timers.advance(RING_TIMEOUT_MS);
    expect(await device.nextState("ended")).toMatchObject({ callId, reason: "timeout" });
    expect(await app.nextState("ended")).toMatchObject({ callId, reason: "timeout" });

    device.write({ t: "button", index: 0 });
    const second = await app.next("call.ringing");
    app.write({ t: "call.answer", callId: second.callId });
    await device.nextState("connecting");
    timers.advance(CONNECT_TIMEOUT_MS);
    expect(await device.nextState("ended")).toMatchObject({ reason: "unreachable" });
  });

  it("ends the call when a participant disconnects", async () => {
    const { device, app } = await household();
    device.write({ t: "button", index: 0 });
    const { callId } = await app.next("call.ringing");
    app.write({ t: "call.answer", callId });
    await device.nextState("connecting");
    app.handler.closed();
    expect(await device.nextState("ended")).toMatchObject({ callId, reason: "hangup" });
  });

  it("reports unreachable, busy, and denied without ringing anyone", async () => {
    const { device, app, deviceId, token } = await household();
    // Unmapped button: denied.
    device.write({ t: "button", index: 3 });
    expect(await device.nextState("ended")).toMatchObject({ reason: "denied" });

    // Handset up: busy.
    device.write({ t: "hook", state: "up" });
    app.write({ t: "call.dial", deviceId });
    expect(await app.nextState("ended")).toMatchObject({ reason: "busy" });
    device.write({ t: "hook", state: "down" });

    // Guardian offline: unreachable.
    app.handler.closed();
    device.write({ t: "button", index: 0 });
    expect(await device.nextState("ended")).toMatchObject({ reason: "unreachable" });

    // Device offline: unreachable.
    device.handler.closed();
    const app2 = await connectApp(token);
    app2.write({ t: "call.dial", deviceId });
    expect(await app2.nextState("ended")).toMatchObject({ reason: "unreachable" });
  });

  it("applies the allow-list and quiet hours", async () => {
    const { device, deviceId, user } = await household();
    const grandma = await store.createUser(
      { householdId: user.householdId, name: "Grandma", role: "contact" },
      0,
    );
    const grandmaToken = await store.createSession(grandma.id, timers.now);
    const grandmaApp = await connectApp(grandmaToken);

    // Not on the allow-list yet.
    grandmaApp.write({ t: "call.dial", deviceId });
    expect(await grandmaApp.nextState("ended")).toMatchObject({ reason: "denied" });

    const g = { token: await store.createSession(user.id, timers.now) };
    await http(`/devices/${deviceId}/contacts/${grandma.id}`, {
      method: "PUT",
      token: g.token,
      body: { label: "Grandma", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
    });
    await http(`/devices/${deviceId}/buttons/1`, {
      method: "PUT",
      token: g.token,
      body: { userId: grandma.id },
    });
    await device.next("config"); // pushed by the allow-list change, before the button mapping
    expect(await device.next("config")).toMatchObject({
      buttons: [
        { index: 0, label: "Mom" },
        { index: 1, label: "Grandma" },
      ],
    });

    // All-day quiet hours: Grandma gets voicemail, the kid cannot call her, Mom still can.
    const res = await http("/quiet-hours", {
      method: "PUT",
      token: g.token,
      body: { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }] },
    });
    expect(res.status).toBe(204);
    expect(await device.next("config")).toMatchObject({ quiet: true });

    grandmaApp.write({ t: "call.dial", deviceId });
    expect(await grandmaApp.nextState("ended")).toMatchObject({ reason: "voicemail" });
    expect(device.sent.some((m) => m.t === "call.ringing")).toBe(false);

    device.write({ t: "button", index: 1 });
    expect(await device.nextState("ended")).toMatchObject({ reason: "denied" });
  });

  it("pushes config when quiet hours begin on their own", async () => {
    const { device, token } = await household();
    await http("/quiet-hours", {
      method: "PUT",
      token,
      body: { rules: [{ days: [1], start: "12:05", end: "13:00" }] },
    });
    expect(await device.next("config")).toMatchObject({ quiet: false });
    timers.advance(6 * 60_000);
    expect(await device.next("config")).toMatchObject({ quiet: true });
  });

  it("keeps households apart", async () => {
    const a = await household();
    // A second household on the same instance.
    const other = await store.createHousehold(
      { name: "Other", timeZone: "UTC", guardianName: "Eve" },
      0,
    );
    const eveToken = await store.createSession(other.guardian.id, timers.now);
    const eve = await connectApp(eveToken);
    eve.write({ t: "call.dial", deviceId: a.deviceId });
    expect((await eve.next("error")).code).toBe("not_found");
    expect((await http(`/devices/${a.deviceId}/contacts`, { token: eveToken })).status).toBe(404);
    expect(eve.sent.some((m) => m.t === "device.status")).toBe(false);
  });

  it("forwards device status to guardians", async () => {
    const { device, app, deviceId } = await household();
    device.write({
      t: "status",
      battery: { pct: 14, charging: false },
      rssi: -60,
      power: { source: "default", reduced: true },
    });
    let status = await app.next("device.status");
    while (!status.battery) status = await app.next("device.status");
    expect(status).toMatchObject({
      deviceId,
      online: true,
      battery: { pct: 14, charging: false },
      power: { source: "default", reduced: true },
    });
    device.handler.closed();
    expect(await app.next("device.status")).toMatchObject({ deviceId, online: false });
  });
});

describe("resuming after the host sleeps", () => {
  /** Simulates Durable Object hibernation: a fresh gateway rebuilt from socket memos. */
  function hibernate(conns: { conn: FakeConn; app: boolean }[]) {
    gateway = new Gateway(env);
    api = createApi(env, gateway);
    const handlers = gateway.resume(
      conns.map(({ conn, app }) => ({ conn, memo: conn.memo, app })),
      (hh) => savedRooms.get(hh) ?? [],
    );
    conns.forEach(({ conn }, i) => {
      conn.handler = handlers[i] as ConnectionHandler;
    });
  }

  it("keeps an active call and its participants", async () => {
    const { device, app } = await household();
    device.write({ t: "hook", state: "up" });
    device.write({ t: "button", index: 0 });
    const { callId } = await app.next("call.ringing");
    app.write({ t: "call.answer", callId });
    device.write({ t: "rtc.sdp", callId, type: "offer", sdp: "o" });
    app.write({ t: "rtc.sdp", callId, type: "answer", sdp: "a" });
    await device.nextState("active");
    expect(savedRooms.values().next().value).toMatchObject([{ id: callId }]);

    hibernate([
      { conn: device, app: false },
      { conn: app, app: true },
    ]);

    // Signaling and hangup still reach the other side, and hook state was remembered.
    app.write({ t: "rtc.ice", callId, candidate: "late" });
    expect((await device.next("rtc.ice")).candidate).toBe("late");
    device.write({ t: "call.hangup", callId });
    expect(await app.nextState("ended")).toMatchObject({ callId, reason: "hangup" });
    expect(savedRooms.values().next().value).toEqual([]);
    app.write({ t: "call.dial", deviceId: (device.memo as { peer: { id: string } }).peer.id });
    expect(await app.nextState("ended")).toMatchObject({ reason: "busy" }); // handset still up
  });

  it("still delivers pair.done to a device that was waiting for a code", async () => {
    const g = await setup();
    const conn = openDevice();
    conn.write(hello());
    conn.write({ t: "pair.begin", publicKey: (await newKey()).publicKey });
    const { code } = await conn.next("pair.code");
    expect(conn.memo).toEqual({ kind: "pairing", code });

    hibernate([{ conn, app: false }]);

    const res = await http("/devices/pair", { token: g.token, body: { code, name: "Kid" } });
    expect(res.status).toBe(201);
    expect(await conn.next("pair.done")).toMatchObject({ deviceId: res.json.id });
  });

  it("asks mid-handshake sockets to reconnect", async () => {
    const conn = openDevice();
    hibernate([{ conn, app: false }]);
    expect(conn.closed?.code).toBe(CloseCode.badHandshake);
  });
});

describe("invites", () => {
  it("brings a new contact in, once", async () => {
    const g = await setup();
    const created = await http("/invites", {
      token: g.token,
      body: { name: "Grandma", role: "contact" },
    });
    expect(created.status).toBe(201);
    const invite = created.json.token as string;
    expect((await http(`/invites/${invite}`)).json).toMatchObject({
      householdName: "Home",
      name: "Grandma",
      role: "contact",
      existing: false,
    });
    const accepted = await http("/invites/accept", { body: { token: invite } });
    expect(accepted.status).toBe(201);
    expect(accepted.json.user).toMatchObject({ name: "Grandma", role: "contact" });
    expect((await http("/me", { token: accepted.json.token })).status).toBe(200);
    expect((await http("/invites/accept", { body: { token: invite } })).status).toBe(404);
  });

  it("makes sign-in links for existing people and keeps them in the household", async () => {
    const g = await setup();
    const link = await http("/invites", { token: g.token, body: { userId: g.user.id } });
    const accepted = await http("/invites/accept", { body: { token: link.json.token } });
    expect(accepted.json.user.id).toBe(g.user.id);
    const other = await store.createHousehold(
      { name: "Other", timeZone: "UTC", guardianName: "Eve" },
      0,
    );
    const stranger = await http("/invites", {
      token: g.token,
      body: { userId: other.guardian.id },
    });
    expect(stranger.status).toBe(404);
  });

  it("is guardian-only", async () => {
    const g = await setup();
    const kid = await store.createUser(
      { householdId: g.user.householdId, name: "Kid", role: "contact" },
      0,
    );
    const kidToken = await store.createSession(kid.id, timers.now);
    const res = await http("/invites", { token: kidToken, body: { name: "X", role: "guardian" } });
    expect(res.status).toBe(403);
  });

  it("removing a person revokes their access and allow-list entry", async () => {
    const { deviceId, token, user } = await household();
    const grandma = await store.createUser(
      { householdId: user.householdId, name: "Grandma", role: "contact" },
      0,
    );
    const grandmaToken = await store.createSession(grandma.id, timers.now);
    await store.upsertContact(deviceId, {
      id: grandma.id,
      label: "Grandma",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    expect((await http(`/users/${user.id}`, { method: "DELETE", token })).status).toBe(400);
    expect((await http(`/users/${grandma.id}`, { method: "DELETE", token })).status).toBe(204);
    expect((await http("/me", { token: grandmaToken })).status).toBe(401);
    expect(await store.getContact(deviceId, grandma.id)).toBeUndefined();
  });
});

describe("voicemail", () => {
  async function quietHousehold() {
    const h = await household();
    const grandma = await store.createUser(
      { householdId: h.user.householdId, name: "Grandma", role: "contact" },
      0,
    );
    const grandmaToken = await store.createSession(grandma.id, timers.now);
    await store.upsertContact(h.deviceId, {
      id: grandma.id,
      label: "Grandma",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    // Monday 12:00 UTC now; quiet 11:00–13:30 on Mondays.
    await http("/quiet-hours", {
      method: "PUT",
      token: h.token,
      body: { rules: [{ days: [1], start: "11:00", end: "13:30" }] },
    });
    return { ...h, grandma, grandmaToken };
  }

  it("tells the phone when quiet hours end", async () => {
    const { device } = await quietHousehold();
    let config = await device.next("config");
    while (!config.quiet) config = await device.next("config");
    expect(config).toMatchObject({ quiet: true, quietUntil: "13:30" });
  });

  it("records, transcribes, announces, and shows as missed until heard", async () => {
    const { device, app, deviceId, token, grandmaToken } = await quietHousehold();
    const audio = new Uint8Array(1234).fill(7);
    const res = await http(`/devices/${deviceId}/voicemail?durationMs=4200`, {
      token: grandmaToken,
      raw: audio,
      type: "audio/webm;codecs=opus",
    });
    expect(res.status).toBe(201);
    const id = res.json.id as string;

    expect(await app.next("voicemail.new")).toMatchObject({ id, deviceId, from: "Grandma" });
    let config = await device.next("config");
    while (!config.missed) config = await device.next("config");
    expect(config.missed).toEqual([{ from: "Grandma" }]);

    await Promise.all(background);
    const list = await http("/voicemails", { token });
    expect(list.json).toMatchObject([
      {
        id,
        fromLabel: "Grandma",
        durationMs: 4200,
        mime: "audio/webm",
        transcript: "heard 1234 bytes",
        transcriptStatus: "done",
        heardAt: null,
      },
    ]);
    expect(list.json[0]).not.toHaveProperty("blobKey");

    const audioRes = await api.request(`/voicemails/${id}/audio`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(audioRes.headers.get("content-type")).toBe("audio/webm;codecs=opus");
    expect(new Uint8Array(await audioRes.arrayBuffer())).toEqual(audio);

    expect((await http(`/voicemails/${id}/heard`, { method: "POST", token })).status).toBe(204);
    config = await device.next("config");
    expect(config.missed).toBeUndefined();

    expect((await http(`/voicemails/${id}`, { method: "DELETE", token })).status).toBe(204);
    expect(blobs.size).toBe(0);
  });

  it("refuses people who may not call the phone, bad types, and oversized audio", async () => {
    const { deviceId, token, user, grandmaToken } = await quietHousehold();
    const stranger = await store.createUser(
      { householdId: user.householdId, name: "Stranger", role: "contact" },
      0,
    );
    const strangerToken = await store.createSession(stranger.id, timers.now);
    const upload = (t: string, raw: BodyInit, type = "audio/webm") =>
      http(`/devices/${deviceId}/voicemail`, { token: t, raw, type });
    expect((await upload(strangerToken, new Uint8Array(10))).status).toBe(403);
    expect((await upload(grandmaToken, new Uint8Array(10), "text/plain")).status).toBe(415);
    expect((await upload(grandmaToken, new Uint8Array(3 * 1024 * 1024))).status).toBe(413);
    expect((await http("/voicemails", { token: grandmaToken })).status).toBe(403);
    expect((await http("/voicemails", { token })).json).toEqual([]);
  });

  it("marks transcripts failed when speech-to-text errors", async () => {
    env.transcriber = { transcribe: async () => Promise.reject(new Error("boom")) };
    const { deviceId, token, grandmaToken } = await quietHousehold();
    await http(`/devices/${deviceId}/voicemail`, {
      token: grandmaToken,
      raw: new Uint8Array(10),
      type: "audio/ogg",
    });
    await Promise.all(background);
    expect((await http("/voicemails", { token })).json[0]).toMatchObject({
      transcriptStatus: "failed",
      transcript: null,
    });
  });
});

describe("P-256 devices", () => {
  it("pair and authenticate with ECDSA", async () => {
    const g = await setup();
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = toBase64Url(
      new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
    );
    const pairing = openDevice();
    pairing.write(hello());
    pairing.write({ t: "pair.begin", alg: "p256", publicKey });
    const { code } = await pairing.next("pair.code");
    await http("/devices/pair", { token: g.token, body: { code, name: "HW" } });
    const { deviceId } = await pairing.next("pair.done");

    const conn = openDevice();
    conn.write(hello(deviceId));
    const { nonce } = await conn.next("auth.challenge");
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      fromBase64Url(nonce),
    );
    conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    expect(await conn.next("config")).toMatchObject({ buttons: [{ index: 0, label: "Mom" }] });
  });
});

describe("passkeys", () => {
  it("issues options and rejects forged or replayed responses", async () => {
    const g = await setup();
    const reg = await http("/passkeys/register/options", { method: "POST", token: g.token });
    expect(reg.json.options).toMatchObject({ rp: { name: "Open Lounge Phone" } });
    const bogus = { id: "x", rawId: "x", type: "public-key", response: {} };
    const verify = await http("/passkeys/register/verify", {
      token: g.token,
      body: { challengeId: reg.json.challengeId, response: bogus },
    });
    expect(verify.status).toBe(400);
    // The challenge was consumed by the failed attempt.
    const replay = await http("/passkeys/register/verify", {
      token: g.token,
      body: { challengeId: reg.json.challengeId, response: bogus },
    });
    expect(replay.status).toBe(400);

    const login = await http("/passkeys/login/options", { method: "POST" });
    expect(login.json.options.challenge).toEqual(expect.any(String));
    const bad = await http("/passkeys/login/verify", {
      body: { challengeId: login.json.challengeId, response: bogus },
    });
    expect(bad.status).toBe(401);
    expect((await http("/passkeys", { token: g.token })).json).toEqual([]);
  });
});

describe("grown-up app-to-app calls", () => {
  async function twoAdults() {
    const g = await setup();
    const dad = await store.createUser(
      { householdId: g.user.householdId, name: "Dad", role: "guardian" },
      0,
    );
    const dadToken = await store.createSession(dad.id, timers.now);
    const mom = await connectApp(g.token);
    return { ...g, mom, dad, dadToken };
  }

  it("shows presence when someone comes online and goes offline", async () => {
    const { mom, dad, dadToken } = await twoAdults();
    expect(await mom.next("member.status")).toEqual({
      t: "member.status",
      userId: dad.id,
      online: false,
      available: true,
    });
    const dadApp = await connectApp(dadToken);
    expect(await mom.next("member.status")).toMatchObject({ userId: dad.id, online: true });
    dadApp.handler.closed();
    expect(await mom.next("member.status")).toMatchObject({ userId: dad.id, online: false });
  });

  it("rings the other person's open sessions and connects like any call", async () => {
    const { mom, dad, dadToken, user } = await twoAdults();
    const dadApp = await connectApp(dadToken);
    mom.write({ t: "call.user", userId: dad.id });
    const { callId } = await mom.nextState("ringing");
    expect(await dadApp.next("call.ringing")).toEqual({
      t: "call.ringing",
      callId,
      from: { label: "Mom" },
    });
    dadApp.write({ t: "call.answer", callId });
    await mom.nextState("connecting");
    mom.write({ t: "rtc.sdp", callId, type: "offer", sdp: "o" });
    expect(await dadApp.next("rtc.sdp")).toMatchObject({ type: "offer" });
    dadApp.write({ t: "rtc.sdp", callId, type: "answer", sdp: "a" });
    await mom.nextState("active");
    expect(user.name).toBe("Mom");
  });

  it("refuses offline, unavailable, busy, self and strangers", async () => {
    const { mom, dad, dadToken, user } = await twoAdults();
    mom.write({ t: "call.user", userId: dad.id });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "unreachable" });

    const dadApp = await connectApp(dadToken);
    dadApp.write({ t: "presence.set", available: false });
    expect(await mom.next("member.status")).toMatchObject({ userId: dad.id, online: true });
    let status = await mom.next("member.status");
    while (status.available) status = await mom.next("member.status");
    expect(status).toMatchObject({ userId: dad.id, available: false });
    mom.write({ t: "call.user", userId: dad.id });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(dadApp.sent.some((m) => m.t === "call.ringing")).toBe(false);
    // Availability persists across sessions and is reported to the person themselves.
    expect((await store.availability(user.householdId)).get(dad.id)).toBe(false);
    expect((await http("/me", { token: dadToken })).json.available).toBe(false);

    dadApp.write({ t: "presence.set", available: true });
    await vi.waitFor(async () =>
      expect((await store.availability(user.householdId)).get(dad.id)).toBe(true),
    );
    const grandma = await store.createUser(
      { householdId: user.householdId, name: "Grandma", role: "contact" },
      0,
    );
    const grandmaApp = await connectApp(await store.createSession(grandma.id, timers.now));
    grandmaApp.write({ t: "call.user", userId: dad.id });
    await dadApp.next("call.ringing");
    mom.write({ t: "call.user", userId: dad.id });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "busy" });

    mom.write({ t: "call.user", userId: user.id });
    expect((await mom.next("error")).message).toMatch(/yourself/);

    const other = await store.createHousehold(
      { name: "O", timeZone: "UTC", guardianName: "Eve" },
      0,
    );
    mom.write({ t: "call.user", userId: other.guardian.id });
    expect((await mom.next("error")).code).toBe("not_found");
  });
});

describe("personal phones", () => {
  /** Pairs a phone as `token`'s own; returns the connected device socket and its id. */
  async function pairMine(token: string, name = "Dad's phone") {
    const key = await newKey();
    const conn = openDevice();
    conn.write(hello());
    conn.write({ t: "pair.begin", publicKey: key.publicKey });
    const { code } = await conn.next("pair.code");
    const res = await http("/devices/pair", { token, body: { code, name, forMe: true } });
    expect(res.status).toBe(201);
    const { deviceId } = await conn.next("pair.done");
    return { deviceId, phone: await connectDevice(deviceId, key.pair) };
  }

  async function family() {
    const g = await setup();
    const dad = await store.createUser(
      { householdId: g.user.householdId, name: "Dad", role: "contact" },
      0,
    );
    const dadToken = await store.createSession(dad.id, timers.now);
    return { ...g, dad, dadToken };
  }

  it("any member can pair their own phone; household phones stay guardian-only", async () => {
    const { dadToken, dad, user } = await family();
    const conn = openDevice();
    conn.write(hello());
    conn.write({ t: "pair.begin", publicKey: (await newKey()).publicKey });
    const { code } = await conn.next("pair.code");
    expect(
      (await http("/devices/pair", { token: dadToken, body: { code, name: "X" } })).status,
    ).toBe(403);
    const { deviceId } = await pairMine(dadToken);
    const list = (await http("/devices", { token: dadToken })).json as {
      id: string;
      ownerUserId: string;
    }[];
    expect(list.find((d) => d.id === deviceId)?.ownerUserId).toBe(dad.id);
    // The owner can manage their own phone; its keys start with the other grown-ups.
    const contacts = await http(`/devices/${deviceId}/contacts`, { token: dadToken });
    expect(contacts.status).toBe(200);
    expect(contacts.json.contacts.map((c: { id: string }) => c.id)).toEqual([user.id]);
    expect(contacts.json.buttons).toEqual({ "0": user.id });
  });

  it("sends a personal phone's status to its (non-guardian) owner", async () => {
    const { dadToken } = await family();
    const dadApp = await connectApp(dadToken);
    const { deviceId, phone } = await pairMine(dadToken);
    let s = await dadApp.next("device.status");
    while (s.deviceId !== deviceId || !s.online) s = await dadApp.next("device.status");
    phone.write({ t: "status", battery: { pct: 50, charging: true } });
    s = await dadApp.next("device.status");
    while (!s.battery) s = await dadApp.next("device.status");
    expect(s).toMatchObject({ deviceId, battery: { pct: 50 } });
  });

  it("a connected personal phone makes its owner show as online", async () => {
    const { token, dad, dadToken } = await family();
    const mom = await connectApp(token);
    expect(await mom.next("member.status")).toMatchObject({ userId: dad.id, online: false });
    const { phone } = await pairMine(dadToken);
    let s = await mom.next("member.status");
    while (s.userId !== dad.id || !s.online) s = await mom.next("member.status");
    phone.handler.closed();
    expect(await mom.next("member.status")).toMatchObject({ userId: dad.id, online: false });
  });

  it("calling a person rings their phone; answering there stops their app ringing", async () => {
    const { token, dad, dadToken } = await family();
    const mom = await connectApp(token);
    const { phone } = await pairMine(dadToken);
    const dadApp = await connectApp(dadToken);
    mom.write({ t: "call.user", userId: dad.id });
    const { callId } = await mom.nextState("ringing");
    expect(await phone.next("call.ringing")).toMatchObject({ callId, from: { label: "Mom" } });
    await dadApp.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.answer", callId });
    expect(await dadApp.nextState("ended")).toMatchObject({ callId });
    await mom.nextState("connecting");
    mom.write({ t: "rtc.sdp", callId, type: "offer", sdp: "o" });
    expect(await phone.next("rtc.sdp")).toMatchObject({ type: "offer" });
    phone.write({ t: "call.hangup", callId });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "hangup" });
  });

  it("with only a phone connected, the phone alone makes them reachable; lifted = busy", async () => {
    const { token, dad, dadToken } = await family();
    const mom = await connectApp(token);
    const { phone } = await pairMine(dadToken);
    phone.write({ t: "hook", state: "up" });
    mom.write({ t: "call.user", userId: dad.id });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "unreachable" });
    phone.write({ t: "hook", state: "down" });
    mom.write({ t: "call.user", userId: dad.id });
    await mom.nextState("ringing");
    await phone.next("call.ringing");
  });

  it("grown-ups' own phones ignore the household's quiet hours", async () => {
    const { token, dadToken } = await family();
    await http("/quiet-hours", {
      method: "PUT",
      token,
      body: { rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }] },
    });
    const { phone } = await pairMine(dadToken);
    const cfg = phone.sent.filter((m) => m.t === "config").at(-1);
    expect(cfg).toMatchObject({ quiet: false });
  });
});

describe("managing phones", () => {
  it("renames, claims as my phone, releases, and removes a phone", async () => {
    const { deviceId, device, token, app } = await household();
    expect(
      (await http(`/devices/${deviceId}`, { method: "PATCH", token, body: { name: "Kitchen" } }))
        .status,
    ).toBe(204);
    await http(`/devices/${deviceId}`, { method: "PATCH", token, body: { owner: "me" } });
    let list = (await http("/devices", { token })).json;
    expect(list[0]).toMatchObject({ name: "Kitchen", ownerUserId: expect.any(String) });
    await http(`/devices/${deviceId}`, { method: "PATCH", token, body: { owner: "household" } });
    list = (await http("/devices", { token })).json;
    expect(list[0].ownerUserId).toBeNull();

    expect((await http(`/devices/${deviceId}`, { method: "DELETE", token })).status).toBe(204);
    await vi.waitFor(() => expect(device.closed?.code).toBe(CloseCode.unauthorized));
    expect((await http("/devices", { token })).json).toEqual([]);
    let s = await app.next("device.status");
    while (s.online) s = await app.next("device.status");
    expect(s).toMatchObject({ deviceId, online: false });
  });

  it("lets a member manage only their own phone", async () => {
    const { deviceId, user } = await household();
    const dad = await store.createUser(
      { householdId: user.householdId, name: "Dad", role: "contact" },
      0,
    );
    const dadToken = await store.createSession(dad.id, timers.now);
    expect(
      (
        await http(`/devices/${deviceId}`, {
          method: "PATCH",
          token: dadToken,
          body: { owner: "me" },
        })
      ).status,
    ).toBe(404);
    expect((await http(`/devices/${deviceId}`, { method: "DELETE", token: dadToken })).status).toBe(
      404,
    );
  });
});
