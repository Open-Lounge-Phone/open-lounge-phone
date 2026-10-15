import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ADDON_CODE, ADDONS_OFF, PHONE_CODE } from "./addons.ts";
import { fedFetch } from "./federation.ts";
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

const BOOK_CLUB = { id: "bookclub", label: "Book club" };
type Linked = Awaited<ReturnType<typeof linkAddon>>;

/** The add-on says what it offers for sharing; resolves once the server has it. */
async function declare(s: TestServer, seat: Linked, shares: { id: string; label: string }[]) {
  seat.conn.write({ t: "addon.shares", shares });
  await vi.waitFor(async () =>
    expect(await s.store.addons.shares(seat.id)).toEqual(
      shares.filter((x, i) => shares.findIndex((y) => y.id === x.id) === i),
    ),
  );
}

/** The owner gives a share to someone (`conn:<id>` or `user:<id>`). */
const give = (s: TestServer, owner: Person, addonId: string, share: string, to: string) =>
  s.http(`/addons/${addonId}/shares/${share}/grants`, { token: owner.token, body: { to } });

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

  it("its own address is its owner's alone, either way; the old allow-list is gone", async () => {
    const ana = await a.person("ana", "Ana");
    const ids = await connect(a, jesse, a, ana);
    // Linking with the old `allow` list still works, and allows nobody.
    const seat = await linkAddon(a, jesse, "seat", [ids.aSide]);
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    anaApp.write({ t: "call.address", address: "jesse+nobody@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    seat.conn.write({ t: "call.address", address: "ana@a.test" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
    expect(anaApp.all("call.ringing")).toEqual([]);
    // There's no whole-add-on list to put anyone on.
    const put = await a.api.request(`/addons/${seat.id}/allow`, {
      method: "PUT",
      headers: { authorization: `Bearer ${jesse.token}`, "content-type": "application/json" },
      body: JSON.stringify({ connections: [ids.aSide] }),
    });
    expect(put.status).toBe(404);
    const list = await a.http("/addons", { token: jesse.token });
    expect(list.json.addons[0]).toMatchObject({ shares: [], allowNote: false });
    expect(list.json.addons[0].allow).toBeUndefined();
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

  it("linking and removing it go in the space's audit trail", async () => {
    const seat = await linkAddon(a, jesse);
    await a.http(`/addons/${seat.id}`, { method: "DELETE", token: jesse.token });
    const trail = await a.http("/space/audit", { token: jesse.token });
    const actions = (trail.json as { action: string; detail: Record<string, unknown> }[])
      .map((e) => e.action)
      .filter((x) => x.startsWith("addon."));
    expect(actions.sort()).toEqual(["addon.link", "addon.remove"]);
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

  it("refuses calls through a kids' phone, and an add-on never calls a phone", async () => {
    const seat = await linkAddon(a, jesse);
    await declare(a, seat, [BOOK_CLUB]);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `conn:${ids.aSide}`), 201);
    const party = { handle: "bob", id: bob.account.id, name: "Bob" };
    // Even holding the share, nothing that comes through a kids' phone reaches it.
    const kids = await a.env.calls?.receive("b.test", {
      callId: "call_kids1",
      from: party,
      to: { kind: "addon", handle: "jesse", name: "seat", share: "bookclub" },
      viaPhone: { label: "Kid" },
    });
    expect(kids).toEqual({ state: "ended", reason: "unavailable" });
    // An add-on calls people, never a phone.
    const toPhone = await b.env.calls?.receive("a.test", {
      callId: "call_kids2",
      from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
      to: { kind: "phone", deviceId: "dev_x" },
      addon: "seat",
      addonShare: { id: "bookclub", label: "Book club" },
    });
    expect(toPhone).toEqual({ state: "ended", reason: "unavailable" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
  });

  it("isn't offered to a server that doesn't take add-on calls", async () => {
    const seat = await linkAddon(a, jesse);
    await declare(a, seat, [BOOK_CLUB]);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `conn:${ids.aSide}`), 201);
    await net.advertise("b.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addons"),
    }));
    seat.conn.write({ t: "call.address", address: "bob@b.test", share: "bookclub" });
    expect(await seat.conn.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "That server doesn't take add-on calls",
    });
    await net.advertise("a.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addons"),
    }));
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(seat.conn.all("call.ringing")).toEqual([]);
  });
});

describe("sharing add-ons on one server", () => {
  let net: Net;
  let a: TestServer;
  let jesse: Person;
  let ana: Person;
  let seat: Linked;
  let anaConn: string;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", { env: { addons: true } });
    jesse = await a.person("jesse", "Jesse");
    ana = await a.person("ana", "Ana");
    anaConn = (await connect(a, jesse, a, ana)).aSide;
    seat = await linkAddon(a, jesse);
  });

  it("a share's address reaches it only for the people holding that share (default deny)", async () => {
    const anaApp = await a.connectApp(ana.token);
    const tryShare = async () => {
      anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
      return anaApp.nextState("ended");
    };
    // No such share yet; then offered but not given to her: both look the same.
    expect(await tryShare()).toMatchObject({ reason: "unavailable" });
    await declare(a, seat, [BOOK_CLUB, { id: "garden", label: "Garden" }]);
    expect(await tryShare()).toMatchObject({ reason: "unavailable" });
    // Only the owner gives shares, and only shares it offers.
    expectStatus(await give(a, ana, seat.id, "bookclub", `conn:${anaConn}`), 404);
    expectStatus(await give(a, jesse, seat.id, "nope", `conn:${anaConn}`), 404);
    const res = await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    expectStatus(res, 201);
    expect(res.json).toMatchObject({ name: "Ana", address: "ana@a.test" });
    // Given: she reaches it at the share's address, and it's told through which share.
    anaApp.write({ t: "call.address", address: "Jesse+Seat+BookClub@a.test" });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.from).toEqual({ label: "Ana", address: "ana@a.test" });
    expect(ring.share).toEqual({ id: "bookclub", label: "Book club", grantId: res.json.grantId });
    const mine = await anaApp.nextState("ringing");
    seat.conn.write({ t: "call.hangup", callId: ring.callId });
    await anaApp.nextState("ended");
    expect(mine.callId).toBeTruthy();
    // Not another share, and not its own address: that stays its owner's.
    anaApp.write({ t: "call.address", address: "jesse+seat+garden@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    anaApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // Its owner calls its own address (no share), not a share's.
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await app.nextState("ended")).toMatchObject({ reason: "unavailable" });
    app.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect((await seat.conn.next("call.ringing")).share).toBeUndefined();
    // Someone who stops being her connection loses it too.
    expectStatus(
      await a.http(`/connections/${anaConn}`, { method: "DELETE", token: jesse.token }),
      204,
    );
    expect(await a.store.addons.grants(seat.id)).toEqual([]);
  });

  it("calls out within a share: to its owner or a holder, labelled with the share", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    const anaApp = await a.connectApp(ana.token);
    const app = await a.connectApp(jesse.token);
    // Not holding it (or no share named): refused, and nothing rings.
    seat.conn.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expectStatus(await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`), 201);
    seat.conn.write({ t: "call.address", address: "ana@a.test" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    seat.conn.write({ t: "call.address", address: "ana@a.test", share: "nope" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(anaApp.all("call.ringing")).toEqual([]);
    // Holding it: she sees the add-on and the share.
    seat.conn.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    const ring = await anaApp.next("call.ringing");
    expect(ring.from).toEqual({
      label: "seat",
      address: "jesse+seat+bookclub@a.test",
      kind: "addon",
      share: "Book club",
    });
    const out = await seat.conn.nextState("ringing");
    anaApp.write({ t: "call.hangup", callId: ring.callId });
    await seat.conn.nextState("ended");
    expect(out.callId).toBeTruthy();
    // Its owner, within a share.
    seat.conn.write({ t: "call.address", address: "jesse@a.test", share: "bookclub" });
    expect((await app.next("call.ringing")).from).toMatchObject({ share: "Book club" });
  });

  it("people in the owner's spaces can hold a share without being connected", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    // Cy is in Jesse's home; Dee has her own home and is also in Jesse's team.
    const cyUser = await a.store.createUser(
      { householdId: jesse.household.id, name: "Cy", role: "contact" },
      net.timers.now,
    );
    const team = await a.store.createHousehold(
      {
        name: "Team",
        timeZone: "UTC",
        guardianName: "Jesse",
        accountId: jesse.account.id,
        type: "team",
      },
      net.timers.now,
    );
    const dee = await a.person("dee", "Dee");
    const deeInTeam = await a.store.createUser(
      { householdId: team.household.id, name: "Dee", role: "contact", accountId: dee.account.id },
      net.timers.now,
    );
    const people = (await a.http("/addons/people", { token: jesse.token })).json as {
      ref: string;
      name: string;
    }[];
    expect(people.map((p) => p.name).sort()).toEqual(["Ana", "Cy", "Dee"]);
    // Not someone outside them.
    const eve = await a.person("eve", "Eve");
    expectStatus(await give(a, jesse, seat.id, "bookclub", `user:${eve.user.id}`), 409);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `user:${jesse.user.id}`), 409);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `user:${cyUser.id}`), 201);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `user:${deeInTeam.id}`), 201);
    // Cy calls it (same space as the add-on), and Dee from her own home.
    const cyApp = await a.connectApp(await a.store.createSession(cyUser.id, net.timers.now));
    cyApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.share?.id).toBe("bookclub");
    seat.conn.write({ t: "call.hangup", callId: ring.callId });
    await cyApp.nextState("ended");
    const deeApp = await a.connectApp(dee.token);
    deeApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    const ring2 = await seat.conn.next("call.ringing");
    expect(ring2.from).toMatchObject({ address: "dee@a.test" });
    seat.conn.write({ t: "call.hangup", callId: ring2.callId });
    await deeApp.nextState("ended");
    // It calls Dee back within the share (another household here, no connection).
    seat.conn.write({ t: "call.address", address: "dee@a.test", share: "bookclub" });
    expect((await deeApp.next("call.ringing")).from).toMatchObject({ share: "Book club" });
    seat.conn.write({ t: "call.hangup", callId: (await seat.conn.nextState("ringing")).callId });
    await deeApp.nextState("ended");
    // Dee leaves the team: her grant no longer works.
    expect((await a.http("/addons/shared", { token: dee.token })).json.held).toHaveLength(1);
    await a.store.deleteUser(deeInTeam.id, net.timers.now);
    deeApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await deeApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // …and it's no longer listed for her.
    expect((await a.http("/addons/shared", { token: dee.token })).json.held).toEqual([]);
  });

  it("revoking ends the holder's live call into the share at once", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    const res = await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    const ring = await seat.conn.next("call.ringing");
    const mine = await anaApp.nextState("ringing");
    await talk(anaApp, seat.conn, mine.callId, ring.callId);
    const del = await a.http(`/addons/${seat.id}/grants/${res.json.grantId}`, {
      method: "DELETE",
      token: jesse.token,
    });
    expectStatus(del, 204);
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(await seat.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // Someone else's grant: not found.
    const again = await a.http(`/addons/${seat.id}/grants/${res.json.grantId}`, {
      method: "DELETE",
      token: jesse.token,
    });
    expectStatus(again, 404);
  });

  it("a share the add-on drops takes its grants and ends calls into it", async () => {
    await declare(a, seat, [BOOK_CLUB, { id: "garden", label: "Garden" }]);
    await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    await give(a, jesse, seat.id, "garden", `conn:${anaConn}`);
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    const ring = await seat.conn.next("call.ringing");
    const mine = await anaApp.nextState("ringing");
    await talk(anaApp, seat.conn, mine.callId, ring.callId);
    // Garden goes: the book club call goes on.
    await declare(a, seat, [BOOK_CLUB]);
    expect(anaApp.all("call.state").at(-1)?.state).toBe("active");
    // A new label is taken; the grant stays.
    await declare(a, seat, [{ id: "bookclub", label: "Book Club" }]);
    expect((await a.store.addons.grants(seat.id)).map((g) => g.shareId)).toEqual(["bookclub"]);
    // The book club goes: the call ends, and offering it again gives it to nobody.
    await declare(a, seat, []);
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    await declare(a, seat, [BOOK_CLUB]);
    expect(await a.store.addons.grants(seat.id)).toEqual([]);
    anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // Phones and apps can't send what only an add-on may.
    const anaApp2 = await a.connectApp(ana.token);
    anaApp2.write({ t: "addon.shares", shares: [] });
    expect(await a.store.addons.shares(seat.id)).toEqual([BOOK_CLUB]);
  });

  it("kids' phones never reach a share; a holder's own phone can have it on a key", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    // Ana's phones: a kids' phone in her home, and her own desk phone.
    const kid = await a.pairDevice(ana.token, "Kid");
    const kidPhone = await a.connectDevice(kid.deviceId as string, kid.key?.pair as CryptoKeyPair);
    const put = await a.http(`/devices/${kid.deviceId}/lines`, {
      method: "PUT",
      token: ana.token,
      body: { address: "jesse+seat+bookclub@a.test", label: "Book club" },
    });
    expect(put.status).toBe(400);
    expectStatus(await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`), 201);
    const id = await a.store.lines.addToPhone(
      kid.deviceId as string,
      "jesse+seat+bookclub@a.test",
      "Book club",
    );
    await a.store.setButton(kid.deviceId as string, 3, id);
    kidPhone.write({ t: "hook", state: "up" });
    kidPhone.write({ t: "button", index: 3 });
    expect(await kidPhone.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(seat.conn.all("call.ringing")).toEqual([]);

    const phone = await a.pairDevice(ana.token, "Desk", { forMe: true });
    const desk = await a.connectDevice(phone.deviceId as string, phone.key?.pair as CryptoKeyPair);
    const line = await a.http(`/devices/${phone.deviceId}/lines`, {
      method: "PUT",
      token: ana.token,
      body: { address: "jesse+seat+bookclub@a.test", label: "Book club" },
    });
    expectStatus(line, 200);
    await a.http(`/devices/${phone.deviceId}/buttons/2`, {
      method: "PUT",
      token: ana.token,
      body: { userId: line.json.id },
    });
    desk.write({ t: "hook", state: "up" });
    desk.write({ t: "button", index: 2 });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.from).toEqual({ label: "Ana", address: "ana@a.test" });
    expect(ring.share?.id).toBe("bookclub");
  });

  it("who sees it: its owner sees shares and holders; holders see theirs; nobody else", async () => {
    await declare(a, seat, [BOOK_CLUB, { id: "garden", label: "Garden" }]);
    const grant = await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    const cy = await a.store.createUser(
      { householdId: jesse.household.id, name: "Cy", role: "guardian" },
      net.timers.now,
    );
    const cyToken = await a.store.createSession(cy.id, net.timers.now);
    const mine = await a.http("/addons", { token: jesse.token });
    expect(mine.json.addons[0].shares).toEqual([
      {
        id: "bookclub",
        label: "Book club",
        address: "jesse+seat+bookclub@a.test",
        holders: [{ grantId: grant.json.grantId, name: "Ana", address: "ana@a.test" }],
      },
      { id: "garden", label: "Garden", address: "jesse+seat+garden@a.test", holders: [] },
    ]);
    expect((await a.http("/addons/shared", { token: ana.token })).json.held).toEqual([
      {
        grantId: grant.json.grantId,
        owner: { name: "Jesse", address: "jesse@a.test" },
        addon: "seat",
        share: BOOK_CLUB,
        address: "jesse+seat+bookclub@a.test",
      },
    ]);
    // Someone else in Jesse's own home (a guardian, even) sees nothing of it.
    for (const token of [cyToken]) {
      expect((await a.http("/addons", { token })).json.addons).toEqual([]);
      expect((await a.http("/addons/shared", { token })).json.held).toEqual([]);
      expect(
        (
          await a.http(`/addons/${seat.id}/share-requests`, {
            token,
            body: { label: "x", with: [] },
          })
        ).status,
      ).toBe(404);
    }
    // A share that went is gone from her list too.
    await declare(a, seat, [{ id: "garden", label: "Garden" }]);
    expect((await a.http("/addons/shared", { token: ana.token })).json.held).toEqual([]);
  });

  it("New shared project with…: the add-on makes it, and the people get it", async () => {
    const anaApp = await a.connectApp(ana.token);
    const ask = (label: string, w = [`conn:${anaConn}`]) =>
      a.http(`/addons/${seat.id}/share-requests`, {
        token: jesse.token,
        body: { label, with: w },
      });
    const res = await ask("Book club");
    expectStatus(res, 202);
    expect(res.json).toMatchObject({ label: "Book club", state: "waiting", people: ["Ana"] });
    const req = await seat.conn.next("addon.share.request");
    expect(req).toMatchObject({
      requestId: res.json.id,
      label: "Book club",
      by: "jesse@a.test",
      with: ["ana@a.test"],
    });
    // It must offer the share first.
    seat.conn.write({ t: "addon.share.created", requestId: req.requestId, id: "bookclub" });
    expect((await seat.conn.next("error")).message).toMatch(/addon.shares/);
    seat.conn.write({ t: "addon.shares", shares: [BOOK_CLUB] });
    seat.conn.write({ t: "addon.share.created", requestId: req.requestId, id: "bookclub" });
    await vi.waitFor(async () => {
      const r = await a.http(`/addons/${seat.id}/share-requests/${res.json.id}`, {
        token: jesse.token,
      });
      expect(r.json).toMatchObject({ state: "created", shareId: "bookclub" });
    });
    await vi.waitFor(async () =>
      expect((await a.store.addons.grants(seat.id)).map((g) => g.name)).toEqual(["Ana"]),
    );
    await anaApp.next("connections.changed");
    // Answering twice changes nothing.
    seat.conn.write({ t: "addon.share.refused", requestId: req.requestId, reason: "no" });
    expect((await seat.conn.next("error")).message).toMatch(/isn't waiting/);
    // Someone who isn't yours can't be in it.
    const eve = await a.person("eve", "Eve");
    expectStatus(await ask("X", [`user:${eve.user.id}`]), 409);

    // Refused: the reason, as the add-on put it.
    const r2 = await ask("Garden");
    const req2 = await seat.conn.next("addon.share.request");
    seat.conn.write({ t: "addon.share.refused", requestId: req2.requestId, reason: "Not now." });
    await vi.waitFor(async () => {
      const r = await a.http(`/addons/${seat.id}/share-requests/${r2.json.id}`, {
        token: jesse.token,
      });
      expect(r.json).toMatchObject({ state: "refused", reason: "Not now." });
    });

    // Silent: it times out after a minute, and a late answer is turned down.
    const r3 = await ask("Late");
    const req3 = await seat.conn.next("addon.share.request");
    net.timers.advance(61_000);
    const late = await a.http(`/addons/${seat.id}/share-requests/${r3.json.id}`, {
      token: jesse.token,
    });
    expect(late.json.state).toBe("timeout");
    seat.conn.write({ t: "addon.shares", shares: [BOOK_CLUB, { id: "late", label: "Late" }] });
    seat.conn.write({ t: "addon.share.created", requestId: req3.requestId, id: "late" });
    expect((await seat.conn.next("error")).message).toMatch(/isn't waiting/);
    expect((await a.store.addons.grants(seat.id)).map((g) => g.shareId)).toEqual(["bookclub"]);

    // Offline: said at once.
    seat.conn.close(1000, "bye");
    const r4 = await ask("Offline");
    expect(r4.json.state).toBe("offline");

    // The audit trail has each step, and none of the add-on's words.
    const trail = (await a.http("/space/audit", { token: jesse.token })).json as {
      action: string;
      detail: Record<string, unknown>;
    }[];
    const steps = trail.map((e) => e.action).filter((x) => x.startsWith("addon."));
    for (const x of [
      "addon.share.request",
      "addon.share.created",
      "addon.grant",
      "addon.share.refused",
      "addon.share.timeout",
      "addon.share.offline",
    ]) {
      expect(steps).toContain(x);
    }
    expect(JSON.stringify(trail)).not.toContain("Not now.");
  });

  it("granting and revoking go in the audit trail", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    const g = await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    await a.http(`/addons/${seat.id}/grants/${g.json.grantId}`, {
      method: "DELETE",
      token: jesse.token,
    });
    const trail = (await a.http("/space/audit", { token: jesse.token })).json as {
      action: string;
      detail: Record<string, unknown>;
    }[];
    expect(trail.find((e) => e.action === "addon.grant")?.detail).toMatchObject({
      share: "bookclub",
      to: "ana@a.test",
    });
    expect(trail.find((e) => e.action === "addon.revoke")?.detail).toMatchObject({
      share: "bookclub",
      from: "ana@a.test",
    });
  });

  it("with add-ons off: no granting, no requests, and shares can't be called", async () => {
    await declare(a, seat, [BOOK_CLUB]);
    await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`);
    a.env.addons = false;
    expect((await give(a, jesse, seat.id, "bookclub", `conn:${anaConn}`)).json.error).toBe(
      ADDONS_OFF,
    );
    const req = await a.http(`/addons/${seat.id}/share-requests`, {
      token: jesse.token,
      body: { label: "x", with: [] },
    });
    expect(req.json.error).toBe(ADDONS_OFF);
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect((await a.http("/addons/shared", { token: ana.token })).json.held).toEqual([]);
  });
});

describe("sharing add-ons across servers", () => {
  let net: Net;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  let ids: { aSide: string; bSide: string };
  let seat: Linked;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", { env: { addons: true } });
    b = await net.server("b.test", { env: { addons: true } });
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
    ids = await connect(a, jesse, b, bob);
    seat = await linkAddon(a, jesse);
    await declare(a, seat, [BOOK_CLUB]);
  });

  const bobsShares = async () =>
    (await b.http("/connections", { token: bob.token })).json.connections.find(
      (c: { id: string }) => c.id === ids.bSide,
    ).addonShares;

  it("a holder elsewhere sees it on the connection, calls it, and is called within it", async () => {
    const g = await give(a, jesse, seat.id, "bookclub", `conn:${ids.aSide}`);
    expectStatus(g, 201);
    expect(await bobsShares()).toEqual([
      {
        addon: "seat",
        share: "bookclub",
        label: "Book club",
        address: "jesse+seat+bookclub@a.test",
      },
    ]);
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    const ring = await seat.conn.next("call.ringing");
    expect(ring.from).toEqual({ label: "Bob", address: "bob@b.test" });
    expect(ring.share).toEqual({ ...BOOK_CLUB, grantId: g.json.grantId });
    const mine = await bobApp.nextState("ringing");
    await talk(bobApp, seat.conn, mine.callId, ring.callId);
    bobApp.write({ t: "call.hangup", callId: mine.callId });
    await seat.conn.nextState("ended");
    await bobApp.nextState("ended");
    // Its own address stays its owner's.
    bobApp.write({ t: "call.address", address: "jesse+seat@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "unavailable" });

    seat.conn.write({ t: "call.address", address: "bob@b.test", share: "bookclub" });
    const back = await bobApp.next("call.ringing");
    expect(back.from).toEqual({
      label: "seat",
      address: "jesse+seat+bookclub@a.test",
      kind: "addon",
      share: "Book club",
    });
    const out = await seat.conn.nextState("ringing");
    await talk(seat.conn, bobApp, out.callId, back.callId);
    // Revoked mid-call: it ends at once on both sides, and his server forgets the entry.
    await a.http(`/addons/${seat.id}/grants/${g.json.grantId}`, {
      method: "DELETE",
      token: jesse.token,
    });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    await vi.waitFor(async () => expect(await bobsShares()).toEqual([]));
    bobApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // His history names the share.
    await vi.waitFor(async () =>
      expect((await b.store.callLog(bob.account.id)).map((r) => r.peer)).toContain(
        "jesse+seat+bookclub@a.test",
      ),
    );
  });

  it("a server without addon-shares can't receive grants or calls into shares", async () => {
    await net.advertise("b.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addon-shares"),
    }));
    const g = await give(a, jesse, seat.id, "bookclub", `conn:${ids.aSide}`);
    expect(g.status).toBe(409);
    expect(g.json.error).toMatch(/doesn't take shared add-ons/);
    // Granted earlier (or anyway): the add-on can't call into that server within the share.
    await a.store.addons.grant(
      seat.id,
      "bookclub",
      {
        host: "b.test",
        accountId: bob.account.id,
        handle: "bob",
        name: "Bob",
        connectionId: ids.aSide,
      },
      net.timers.now,
    );
    seat.conn.write({ t: "call.address", address: "bob@b.test", share: "bookclub" });
    expect(await seat.conn.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "That server doesn't take shared add-ons yet",
    });
    // And a server that doesn't list it isn't asked to ring one of its shares.
    await net.advertise("b.test", (doc) => doc);
    await net.advertise("a.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addon-shares"),
    }));
    const bobApp = await b.connectApp(bob.token);
    bobApp.write({ t: "call.address", address: "jesse+seat+bookclub@a.test" });
    expect(await bobApp.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "That server doesn't take shared add-ons yet",
    });
    expect(seat.conn.all("call.ringing")).toEqual([]);
  });

  it("only a connection's own server can tell what it shares", async () => {
    const c = await net.server("c.test", { env: { addons: true } });
    const shares = [{ addon: "seat", share: "x", label: "X" }];
    // Another server can't speak for Jesse: a signed list from c.test "from" her is ignored.
    const party = { handle: "jesse", id: jesse.account.id, name: "Jesse" };
    const res = await fedFetch(c.env, "b.test", "/addon-shares", {
      json: { from: party, to: "bob", shares },
    });
    expect(res.status).toBe(202);
    expect(await bobsShares()).toEqual([]);
    // Unsigned: refused outright.
    const raw = await b.root.request("/fed/v1/addon-shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: party, to: "bob", shares }),
    });
    expect(raw.status).toBeGreaterThanOrEqual(400);
    expect(await bobsShares()).toEqual([]);
    // Someone whose knock Bob hasn't answered yet can't put anything on his list.
    const carol = await a.person("carol", "Carol");
    await a.http("/connections", { token: carol.token, body: { to: bob.address } });
    const carolParty = { handle: "carol", id: carol.account.id, name: "Carol" };
    await fedFetch(a.env, "b.test", "/addon-shares", {
      json: { from: carolParty, to: "bob", shares },
    });
    const knock = (await b.http("/connections", { token: bob.token })).json.connections.find(
      (c: { address: string }) => c.address === carol.address,
    );
    expect(knock.state).not.toBe("active");
    expect(await b.store.addons.received(knock.id)).toEqual([]);
    // From her own server, about their connection: kept.
    await fedFetch(a.env, "b.test", "/addon-shares", { json: { from: party, to: "bob", shares } });
    expect(await bobsShares()).toEqual([{ ...shares[0], address: "jesse+seat+x@a.test" }]);
  });
});
