import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_CODE, ADDONS_OFF, PHONE_CODE } from "./addons.ts";
import {
  expectStatus,
  type FakeConn,
  hello,
  type Network as Net,
  Network,
  newKey,
  type TestServer,
} from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;
type Key = Awaited<ReturnType<typeof newKey>>;

const addonHello = (deviceId?: string) => ({
  ...hello(deviceId),
  model: "addon",
  fw: "olp-addon/test",
  buttons: 1,
  display: "none",
});

/** An add-on asks for a code: answers the code (and its socket, waiting for `pair.done`). */
async function addonCode(s: TestServer, key: Key) {
  const conn = s.openDevice();
  conn.write(addonHello());
  conn.write({ t: "pair.begin", kind: "addon", publicKey: key.publicKey });
  const { code } = await conn.next("pair.code");
  return { conn, code };
}

/** Connects a linked add-on (the signed challenge); answers its socket after `config`. */
async function connectAddon(s: TestServer, id: string, key: Key) {
  const conn = s.openDevice();
  conn.write(addonHello(id));
  const { nonce } = await conn.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", key.pair.privateKey, fromBase64Url(nonce));
  conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  await conn.next("config");
  return conn;
}

/** Links an add-on `name` to `owner`'s account and connects it. */
async function linkAddon(s: TestServer, owner: Person, name = "seat", allow: string[] = []) {
  const key = await newKey();
  const { conn: waiting, code } = await addonCode(s, key);
  const res = await s.http("/addons/link", { token: owner.token, body: { code, name, allow } });
  expectStatus(res, 201);
  const done = await waiting.next("pair.done");
  expect(done.deviceId).toBe(res.json.id);
  const conn = await connectAddon(s, res.json.id, key);
  return { id: res.json.id as string, key, conn, address: res.json.address as string };
}

/** `a` knocks on `b`, `b` accepts; returns both sides' connection ids. */
async function connect(sa: TestServer, a: Person, sb: TestServer, b: Person) {
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
async function talk(caller: FakeConn, callee: FakeConn, callerCall: string, calleeCall: string) {
  callee.write({ t: "call.answer", callId: calleeCall });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId: callerCall, type: "offer", sdp: "v=0 offer" });
  expect(await callee.next("rtc.sdp")).toMatchObject({ type: "offer" });
  callee.write({ t: "rtc.sdp", callId: calleeCall, type: "answer", sdp: "v=0 answer" });
  await caller.nextState("active");
  await callee.nextState("active");
}

describe("add-ons on one server", () => {
  let net: Net;
  let a: TestServer;
  let jesse: Person;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", { env: { addons: true } });
    jesse = await a.person("jesse", "Jesse");
  });

  it("links like a phone pairs, with a name after +, and learns who it is", async () => {
    const key = await newKey();
    const { conn: waiting, code } = await addonCode(a, key);
    // An add-on's code isn't a phone's.
    for (const path of ["/devices/pair/preview", "/devices/pair"]) {
      const res = await a.http(path, { token: jesse.token, body: { code, name: "Seat" } });
      expect(res.json.error).toBe(ADDON_CODE);
    }
    const bad = await a.http("/addons/link", {
      token: jesse.token,
      body: { code, name: "Seat Room!" },
    });
    expectStatus(bad, 400);
    const res = await a.http("/addons/link", { token: jesse.token, body: { code, name: "Seat" } });
    expectStatus(res, 201);
    expect(res.json).toMatchObject({ name: "seat", address: "jesse+seat@a.test", online: false });
    await waiting.next("pair.done");
    // The code was single use.
    const again = await a.http("/addons/link", { token: jesse.token, body: { code, name: "x2" } });
    expectStatus(again, 404);

    const conn = a.openDevice();
    conn.write(addonHello(res.json.id));
    const { nonce } = await conn.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", key.pair.privateKey, fromBase64Url(nonce));
    conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    const config = await conn.next("config");
    expect(config.addon).toEqual({
      name: "seat",
      address: "jesse+seat@a.test",
      owner: { name: "Jesse", address: "jesse@a.test" },
    });
    expect(config.server?.features).toContain("addons");
    expect(config.buttons).toEqual([]);
    const list = await a.http("/addons", { token: jesse.token });
    expect(list.json).toMatchObject({ enabled: true, addons: [{ name: "seat", online: true }] });
    // Not a phone: it's never among the space's phones.
    expect((await a.http("/devices", { token: jesse.token })).json).toEqual([]);
  });

  it("a phone's code isn't an add-on's; names are unique per owner", async () => {
    const phoneKey = await newKey();
    const phone = a.openDevice();
    phone.write(hello());
    phone.write({ t: "pair.begin", publicKey: phoneKey.publicKey });
    const { code } = await phone.next("pair.code");
    const res = await a.http("/addons/link", { token: jesse.token, body: { code, name: "seat" } });
    expect(res.json.error).toBe(PHONE_CODE);
    await linkAddon(a, jesse, "seat");
    const key = await newKey();
    const { code: code2 } = await addonCode(a, key);
    const dup = await a.http("/addons/link", {
      token: jesse.token,
      body: { code: code2, name: "Seat" },
    });
    expectStatus(dup, 409);
  });

  it("its owner calls it and it hears who is calling; minutes count against the owner", async () => {
    a.env.fairUse = { callMinutesPerMonth: 100 };
    const seat = await linkAddon(a, jesse);
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: "Jesse+Seat@a.test" });
    const ringing = await seat.conn.next("call.ringing");
    expect(ringing.from).toEqual({ label: "Jesse", address: "jesse@a.test" });
    const mine = await app.nextState("ringing");
    await talk(app, seat.conn, mine.callId, ringing.callId);
    net.timers.advance(90_000);
    seat.conn.write({ t: "call.hangup", callId: ringing.callId });
    await app.nextState("ended");
    await vi.waitFor(async () =>
      expect((await a.store.usage(jesse.account.id, net.timers.now)).callMinutes).toBe(2),
    );
    // Over the allowance: refused with the reason.
    a.env.fairUse = { callMinutesPerMonth: 2 };
    app.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await app.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(app.all("call.state").at(-1)?.note).toMatch(/call minutes/);
  });

  it("calls its owner: every app and own phone rings, labelled as an add-on", async () => {
    const seat = await linkAddon(a, jesse);
    const app = await a.connectApp(jesse.token);
    const phone = await a.pairDevice(jesse.token, "Desk", { forMe: true });
    const desk = await a.connectDevice(phone.deviceId as string, phone.key?.pair as CryptoKeyPair);
    seat.conn.write({ t: "call.address", address: "jesse@a.test" });
    const ring = await app.next("call.ringing");
    expect(ring.from).toEqual({ label: "seat", address: "jesse+seat@a.test", kind: "addon" });
    expect((await desk.next("call.ringing")).from).toMatchObject({ kind: "addon" });
    const out = await seat.conn.nextState("ringing");
    await talk(seat.conn, app, out.callId, ring.callId);
    // Keys pressed in the call reach the add-on (and only an add-on).
    app.write({ t: "call.key", callId: ring.callId, key: "5" });
    expect(await seat.conn.next("call.key")).toMatchObject({ key: "5", callId: out.callId });
    seat.conn.write({ t: "call.key", callId: out.callId, key: "7" });
    // A call with an add-on is one to one: no transfer.
    app.write({ t: "call.transfer", callId: ring.callId, to: { userId: jesse.user.id } });
    expect((await app.next("error")).message).toMatch(/add-on/);
    expect(app.all("call.key")).toEqual([]);
  });

  it("nobody else reaches it, either way, until its owner allows them", async () => {
    const seat = await linkAddon(a, jesse);
    const ana = await a.person("ana", "Ana");
    const anaApp = await a.connectApp(ana.token);
    // Not connected: refused, and it looks like there's nothing there.
    anaApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    anaApp.write({ t: "call.address", address: "jesse+nobody@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // Connected but not on its list: still refused, both ways.
    const ids = await connect(a, jesse, a, ana);
    anaApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    seat.conn.write({ t: "call.address", address: "ana@a.test" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
    expect(anaApp.all("call.ringing")).toEqual([]);
    // Allowed: both ways, and it is told who is calling.
    // Only active connections of its owner: not someone who hasn't answered a knock yet.
    const cy = await a.person("cy", "Cy");
    await a.http("/connections", { token: jesse.token, body: { to: cy.address } });
    const pending = (await a.http("/connections", { token: jesse.token })).json.connections.find(
      (c: { address: string }) => c.address === cy.address,
    );
    const put = await a.http(`/addons/${seat.id}/allow`, {
      method: "PUT",
      token: jesse.token,
      body: { connections: [ids.aSide, "con_notmine", pending.id] },
    });
    expect(put.json.allow).toEqual([ids.aSide]);
    anaApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.from).toEqual({ label: "Ana", address: "ana@a.test" });
    const mine = await anaApp.nextState("ringing");
    seat.conn.write({ t: "call.hangup", callId: ring.callId });
    await anaApp.nextState("ended");
    expect(mine.callId).toBeTruthy();
    seat.conn.write({ t: "call.address", address: "ana@a.test" });
    expect((await anaApp.next("call.ringing")).from).toEqual({
      label: "seat",
      address: "jesse+seat@a.test",
      kind: "addon",
    });
    // Only its owner manages it.
    const theirs = await a.http(`/addons/${seat.id}/allow`, {
      method: "PUT",
      token: ana.token,
      body: { connections: [] },
    });
    expectStatus(theirs, 404);
    // Nobody can knock on it.
    const knock = await a.http("/connections", {
      token: ana.token,
      body: { to: "jesse+seat@a.test" },
    });
    expect(knock.status).toBe(400);
  });

  it("keys pressed in a call reach only an add-on", async () => {
    const hh = jesse.household.id;
    const ana = await a.store.createUser({ householdId: hh, name: "Ana", role: "contact" }, 0);
    const anaApp = await a.connectApp(await a.store.createSession(ana.id, net.timers.now));
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.user", userId: ana.id });
    const ring = await anaApp.next("call.ringing");
    const mine = await app.nextState("ringing");
    await talk(app, anaApp, mine.callId, ring.callId);
    app.write({ t: "call.key", callId: mine.callId, key: "1" });
    app.write({ t: "call.hangup", callId: mine.callId });
    await anaApp.nextState("ended");
    expect(anaApp.all("call.key")).toEqual([]);
  });

  it("an add-on whose link is gone can't call out: it's told to forget and closed", async () => {
    const seat = await linkAddon(a, jesse);
    // E.g. its owner left the space it was linked in: the row went with them.
    await a.store.addons.delete(seat.id);
    seat.conn.write({ t: "call.address", address: "jesse@a.test" });
    await seat.conn.next("wipe");
    expect(seat.conn.closed).toBeDefined();
    expect(seat.conn.all("call.state")).toEqual([]);
  });

  it("kids' phones never reach one", async () => {
    await linkAddon(a, jesse);
    const kid = await a.pairDevice(jesse.token, "Kid");
    const kidPhone = await a.connectDevice(kid.deviceId as string, kid.key?.pair as CryptoKeyPair);
    // No such key can be set up on a kids' phone…
    const put = await a.http(`/devices/${kid.deviceId}/lines`, {
      method: "PUT",
      token: jesse.token,
      body: { address: "jesse+seat@a.test", label: "Seat" },
    });
    expect(put.status).toBe(400);
    // …and one that got there anyway is refused when pressed.
    const id = await a.store.lines.addToPhone(kid.deviceId as string, "jesse+seat@a.test", "Seat");
    await a.store.setButton(kid.deviceId as string, 3, id);
    kidPhone.write({ t: "hook", state: "up" });
    kidPhone.write({ t: "button", index: 3 });
    const ended = await kidPhone.nextState("ended");
    expect(ended).toMatchObject({ reason: "denied", note: "Kids' phones can't call add-ons" });
  });

  it("its owner's own phone can have it on a key", async () => {
    const seat = await linkAddon(a, jesse);
    const phone = await a.pairDevice(jesse.token, "Desk", { forMe: true });
    const desk = await a.connectDevice(phone.deviceId as string, phone.key?.pair as CryptoKeyPair);
    const put = await a.http(`/devices/${phone.deviceId}/lines`, {
      method: "PUT",
      token: jesse.token,
      body: { address: "jesse+seat@a.test", label: "Seat" },
    });
    expectStatus(put, 200);
    const key = await a.http(`/devices/${phone.deviceId}/buttons/2`, {
      method: "PUT",
      token: jesse.token,
      body: { userId: put.json.id },
    });
    expectStatus(key, 204);
    desk.write({ t: "hook", state: "up" });
    desk.write({ t: "button", index: 2 });
    expect((await seat.conn.next("call.ringing")).from).toEqual({
      label: "Jesse",
      address: "jesse@a.test",
    });
    await desk.nextState("ringing");
  });

  it("removing it revokes it at once: its socket closes and it is told to forget", async () => {
    const seat = await linkAddon(a, jesse);
    const app = await a.connectApp(jesse.token);
    expectStatus(await a.http(`/addons/${seat.id}`, { method: "DELETE", token: jesse.token }), 204);
    expect(seat.conn.all("wipe")).toEqual([{ t: "wipe", reason: "removed" }]);
    expect(seat.conn.closed).toBeDefined();
    app.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await app.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // It comes back: it proves its key and is told to wipe, nothing more.
    const back = a.openDevice();
    back.write(addonHello(seat.id));
    const { nonce } = await back.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", seat.key.pair.privateKey, fromBase64Url(nonce));
    back.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    await back.next("wipe");
    expect(back.all("config")).toEqual([]);
    expect((await a.http("/addons", { token: jesse.token })).json.addons).toEqual([]);
  });

  it("linking, who may talk to it and removing it go in the space's audit trail", async () => {
    const seat = await linkAddon(a, jesse);
    await a.http(`/addons/${seat.id}/allow`, {
      method: "PUT",
      token: jesse.token,
      body: { connections: [] },
    });
    await a.http(`/addons/${seat.id}`, { method: "DELETE", token: jesse.token });
    const trail = await a.http("/space/audit", { token: jesse.token });
    const actions = (trail.json as { action: string; detail: Record<string, unknown> }[])
      .map((e) => e.action)
      .filter((x) => x.startsWith("addon."));
    expect(actions.sort()).toEqual(["addon.allow", "addon.link", "addon.remove"]);
    for (const e of trail.json as { action: string; detail: Record<string, unknown> }[]) {
      if (e.action.startsWith("addon.")) {
        expect(e.detail).toMatchObject({ addonId: seat.id, name: "seat" });
      }
    }
  });

  it("with add-ons off: no linking, linked ones can't connect or be called", async () => {
    const seat = await linkAddon(a, jesse);
    seat.conn.close(1000, "bye");
    a.env.addons = false;
    const key = await newKey();
    const conn = a.openDevice();
    conn.write(addonHello());
    conn.write({ t: "pair.begin", kind: "addon", publicKey: key.publicKey });
    expect((await conn.next("error")).message).toBe(ADDONS_OFF);
    expect(conn.closed).toBeDefined();
    const link = await a.http("/addons/link", {
      token: jesse.token,
      body: { code: "123456", name: "x" },
    });
    expect(link.json.error).toBe(ADDONS_OFF);
    const back = a.openDevice();
    back.write(addonHello(seat.id));
    expect((await back.next("error")).message).toBe(ADDONS_OFF);
    expect(back.closed).toBeDefined();
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await app.nextState("ended")).toMatchObject({ reason: "unavailable" });
    const list = await a.http("/addons", { token: jesse.token });
    expect(list.json).toMatchObject({ enabled: false, addons: [{ online: false }] });
  });
});

describe("add-ons across servers", () => {
  let net: Net;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  let ids: { aSide: string; bSide: string };
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", { env: { addons: true } });
    b = await net.server("b.test", { env: { addons: true } });
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
    ids = await connect(a, jesse, b, bob);
  });

  it("an allowed connection elsewhere calls it, and it calls them, labelled", async () => {
    const seat = await linkAddon(a, jesse, "seat", [ids.aSide]);
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.from).toEqual({ label: "Bob", address: "bob@b.test" });
    const mine = await bobApp.nextState("ringing");
    await talk(bobApp, seat.conn, mine.callId, ring.callId);
    bobApp.write({ t: "call.key", callId: mine.callId, key: "#" });
    expect(await seat.conn.next("call.key")).toMatchObject({ key: "#", callId: ring.callId });
    bobApp.write({ t: "call.hangup", callId: mine.callId });
    await seat.conn.nextState("ended");

    seat.conn.write({ t: "call.address", address: "bob@b.test" });
    const back = await bobApp.next("call.ringing");
    expect(back.from).toEqual({ label: "seat", address: "jesse+seat@a.test", kind: "addon" });
    bobApp.write({ t: "call.hangup", callId: back.callId });
    await seat.conn.nextState("ended");
    // Bob's history names the add-on, not Jesse (it isn't her calling).
    await vi.waitFor(async () =>
      expect((await b.store.callLog(bob.account.id)).map((r) => r.peer)).toEqual([
        "jesse+seat@a.test",
        "jesse+seat@a.test",
      ]),
    );
  });

  it("refuses a connection that isn't allowed, and calls through a kids' phone", async () => {
    const seat = await linkAddon(a, jesse);
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    seat.conn.write({ t: "call.address", address: "bob@b.test" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // Even once allowed, nothing that comes through a kids' phone reaches it.
    await a.http(`/addons/${seat.id}/allow`, {
      method: "PUT",
      token: jesse.token,
      body: { connections: [ids.aSide] },
    });
    const party = { handle: "bob", id: bob.account.id, name: "Bob" };
    const kids = await a.env.calls?.receive("b.test", {
      callId: "call_kids1",
      from: party,
      to: { kind: "addon", handle: "jesse", name: "seat" },
      viaPhone: { label: "Kid" },
    });
    expect(kids).toEqual({ state: "ended", reason: "unavailable" });
    // An add-on calls people, never a phone.
    const toPhone = await b.env.calls?.receive("a.test", {
      callId: "call_kids2",
      from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
      to: { kind: "phone", deviceId: "dev_x" },
      addon: "seat",
    });
    expect(toPhone).toEqual({ state: "ended", reason: "unavailable" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
  });

  it("isn't offered to a server that doesn't take add-on calls", async () => {
    const seat = await linkAddon(a, jesse, "seat", [ids.aSide]);
    await net.advertise("b.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addons"),
    }));
    seat.conn.write({ t: "call.address", address: "bob@b.test" });
    expect(await seat.conn.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "That server doesn't take add-on calls",
    });
    await net.advertise("a.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addons"),
    }));
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
  });
});
