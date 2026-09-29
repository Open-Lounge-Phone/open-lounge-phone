// Voicemail everywhere: unanswered calls (no answer, declined, busy, quiet hours, unavailable,
// offline) offer the caller a single-use ticket; the message lands in the callee's own inbox
// (a person) or with the phone's guardians (a kids' phone). Greetings: default, name, custom.
import type { Weekday } from "@openloungephone/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RING_TIMEOUT_MS } from "./env.ts";
import { fedFetch } from "./federation.ts";
import { expectStatus, type FakeConn, Network, TestServer } from "./testkit.ts";

const AUDIO = new Uint8Array(900).fill(5);

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

/** Jesse (guardian) and Bob (a grown-up member) in one space, both online. */
async function household() {
  const jesse = await s.person("jesse", "Jesse");
  const bob = await s.store.createUser(
    { householdId: jesse.household.id, name: "Bob", role: "contact" },
    0,
  );
  const bobToken = await s.store.createSession(bob.id, s.timers.now);
  return {
    jesse,
    bob,
    bobToken,
    jApp: await s.connectApp(jesse.token),
    bApp: await s.connectApp(bobToken),
  };
}

async function ended(conn: FakeConn) {
  return conn.nextState("ended");
}

/** Leaves a message with the offer's ticket. */
function leave(server: TestServer, ticket: string, durationMs = 5000, body: BodyInit = AUDIO) {
  return server.http(`/vm/message?ticket=${encodeURIComponent(ticket)}&durationMs=${durationMs}`, {
    raw: body,
    type: "audio/webm;codecs=opus",
  });
}

async function greeting(server: TestServer, ticket: string) {
  const res = await server.api.request(`/vm/greeting?ticket=${encodeURIComponent(ticket)}`);
  return {
    status: res.status,
    kind: res.headers.get("olp-greeting"),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

describe("calls that go unanswered go to voicemail", () => {
  it("no answer: rings for the callee's ring time, then the caller gets the offer", async () => {
    const { jesse, bob, bobToken, jApp, bApp } = await household();
    jApp.write({ t: "call.user", userId: bob.id });
    const { callId } = await bApp.next("call.ringing");
    s.timers.advance(RING_TIMEOUT_MS - 1);
    expect(jApp.all("call.state").some((m) => m.state === "ended")).toBe(false);
    s.timers.advance(1);
    const end = await ended(jApp);
    expect(end).toMatchObject({ callId, reason: "timeout" });
    expect(end.voicemail).toMatchObject({
      name: "Bob",
      maxMs: 120_000,
      prompts: ["name", "vm.cant_take", "vm.leave_message", "vm.tone"],
    });
    // Only the caller gets an offer.
    expect((await ended(bApp)).voicemail).toBeUndefined();

    const ticket = end.voicemail?.ticket as string;
    expect(await greeting(s, ticket)).toMatchObject({ status: 204, kind: "default" });
    expectStatus(await leave(s, ticket), 201);
    expect(await bApp.next("voicemail.inbox")).toMatchObject({ from: "Jesse" });
    await Promise.all(s.background);
    const inbox = await s.http("/voicemails", { token: bobToken });
    expect(inbox.json).toMatchObject([
      {
        toUser: bob.id,
        deviceId: null,
        fromLabel: "Jesse",
        fromUser: jesse.user.id,
        durationMs: 5000,
        transcript: "heard 900 bytes",
      },
    ]);
    // Not in the caller's inbox, and a ticket works once.
    expect((await s.http("/voicemails", { token: jesse.token })).json).toEqual([]);
    expectStatus(await leave(s, ticket), 404);
    // The callee's timeline links the missed call to the message.
    expect(await s.store.callLog(bob.accountId, `user:${jesse.user.id}`)).toMatchObject([
      { direction: "in", answered: false, endReason: "timeout", voicemailId: inbox.json[0].id },
    ]);
    // Bob opens it: audio, heard, delete (blob gone).
    const id = inbox.json[0].id as string;
    const audio = await s.api.request(`/voicemails/${id}/audio`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO);
    // Jesse (a guardian) can't open Bob's personal voicemail.
    expectStatus(await s.http(`/voicemails/${id}/audio`, { token: jesse.token }), 404);
    expectStatus(await s.http(`/voicemails/${id}`, { method: "DELETE", token: bobToken }), 204);
    expect([...s.blobs.keys()].filter((k) => k.startsWith("voicemail/"))).toEqual([]);
  });

  it("uses each person's own ring time", async () => {
    const { bob, bobToken, jApp, bApp } = await household();
    expectStatus(
      await s.http("/voicemail/settings", {
        method: "PATCH",
        token: bobToken,
        body: { ringSeconds: 40 },
      }),
      204,
    );
    expectStatus(
      await s.http("/voicemail/settings", {
        method: "PATCH",
        token: bobToken,
        body: { ringSeconds: 5 },
      }),
      400,
    );
    jApp.write({ t: "call.user", userId: bob.id });
    await bApp.next("call.ringing");
    s.timers.advance(39_000);
    expect(jApp.all("call.state").some((m) => m.state === "ended")).toBe(false);
    s.timers.advance(1_000);
    expect((await ended(jApp)).voicemail).toBeDefined();
  });

  it("declined: the caller gets the offer", async () => {
    const { bob, jApp, bApp } = await household();
    jApp.write({ t: "call.user", userId: bob.id });
    const { callId } = await bApp.next("call.ringing");
    bApp.write({ t: "call.hangup", callId });
    const end = await ended(jApp);
    expect(end).toMatchObject({ reason: "declined" });
    expect(end.voicemail?.ticket).toBeTruthy();
  });

  it("busy: refused at once, with the offer", async () => {
    const { jesse, bob, bApp, jApp } = await household();
    const carol = await s.store.createUser(
      { householdId: jesse.household.id, name: "Carol", role: "contact" },
      0,
    );
    await s.connectApp(await s.store.createSession(carol.id, s.timers.now));
    bApp.write({ t: "call.user", userId: carol.id }); // Bob is on another call
    await bApp.nextState("ringing");
    jApp.write({ t: "call.user", userId: bob.id });
    const end = await ended(jApp);
    expect(end).toMatchObject({ reason: "busy" });
    expectStatus(await leave(s, end.voicemail?.ticket as string), 201);
  });

  it("unavailable or offline: straight to voicemail, nothing rings", async () => {
    const { bob, jApp, bApp } = await household();
    bApp.write({ t: "presence.set", available: false });
    await vi.waitFor(async () =>
      expect((await s.store.availability(bob.householdId)).get(bob.id)).toBe(false),
    );
    jApp.write({ t: "call.user", userId: bob.id });
    const busy = await ended(jApp);
    expect(busy).toMatchObject({ reason: "unavailable" });
    expect(busy.voicemail).toBeDefined();
    expect(bApp.all("call.ringing")).toEqual([]);
    bApp.close(1000, "bye");
    jApp.write({ t: "call.user", userId: bob.id });
    const offline = await ended(jApp);
    expect(offline).toMatchObject({ reason: "unreachable" });
    expectStatus(await leave(s, offline.voicemail?.ticket as string), 201);
  });

  it("the caller hanging up, or a call that was never allowed, offers nothing", async () => {
    const { bob, jApp, bApp } = await household();
    jApp.write({ t: "call.user", userId: bob.id });
    const { callId } = await bApp.next("call.ringing");
    jApp.write({ t: "call.hangup", callId });
    expect((await ended(jApp)).voicemail).toBeUndefined();
  });
});

describe("kids' phones", () => {
  async function kidPhone() {
    const h = await household();
    const paired = await s.pairDevice(h.jesse.token, "Lily");
    const deviceId = paired.deviceId as string;
    const phone = await s.connectDevice(deviceId, paired.key?.pair as CryptoKeyPair);
    return { ...h, deviceId, phone };
  }

  const allow = (deviceId: string, userId: string, label: string, flags: object) =>
    s.store.upsertContact(deviceId, {
      id: userId,
      label,
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
      ...flags,
      ...{},
    });

  it("a phone as the caller: no answer, the message lands in the grown-up's inbox", async () => {
    const { jesse, deviceId, phone, jApp } = await kidPhone();
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 0 }); // key 1 = Jesse (the guardian who paired it)
    await jApp.next("call.ringing");
    s.timers.advance(RING_TIMEOUT_MS);
    const end = await phone.nextState("ended");
    expect(end).toMatchObject({ reason: "timeout", voicemail: { name: "Jesse" } });
    await jApp.nextState("ended");
    expectStatus(await leave(s, end.voicemail?.ticket as string), 201);
    expect(await jApp.next("voicemail.inbox")).toMatchObject({ from: "Lily" });
    const inbox = await s.http("/voicemails", { token: jesse.token });
    expect(inbox.json).toMatchObject([
      {
        toUser: jesse.user.id,
        fromLabel: "Lily",
        fromUser: null,
        fromAddress: `device:${deviceId}`,
      },
    ]);
  });

  it("quiet hours: a caller on the allow-list goes straight to voicemail for the guardians", async () => {
    const { jesse, bob, bobToken, deviceId, phone, jApp } = await kidPhone();
    await allow(deviceId, bob.id, "Uncle Bob", {});
    const rules = [{ days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], start: "00:00", end: "23:59" }];
    await s.http("/quiet-hours", { method: "PUT", token: jesse.token, body: { rules } });
    const bApp2 = await s.connectApp(bobToken);
    bApp2.write({ t: "call.dial", deviceId });
    const end = await ended(bApp2);
    expect(end).toMatchObject({ reason: "voicemail", voicemail: { name: "Lily" } });
    expect(phone.all("call.ringing")).toEqual([]);
    expectStatus(await leave(s, end.voicemail?.ticket as string), 201);
    expect(await jApp.next("voicemail.new")).toMatchObject({ deviceId, from: "Uncle Bob" });
    let config = await phone.next("config");
    while (!config.missed) config = await phone.next("config");
    expect(config.missed).toEqual([{ from: "Uncle Bob" }]);
    // The guardians' inbox has it; Bob (not a guardian) can neither list nor open it.
    const list = (await s.http("/voicemails", { token: jesse.token })).json;
    expect(list).toMatchObject([{ deviceId, toUser: null, fromLabel: "Uncle Bob" }]);
    expect((await s.http("/voicemails", { token: bobToken })).json).toEqual([]);
    expectStatus(await s.http(`/voicemails/${list[0].id}/audio`, { token: bobToken }), 404);
    const opened = await s.api.request(`/voicemails/${list[0].id}/audio`, {
      headers: { authorization: `Bearer ${jesse.token}` },
    });
    expect(opened.status).toBe(200);
  });

  it("keeps the allow-list rules: no offer without a grant, and a revoked grant stops the message", async () => {
    const { jesse, bob, bobToken, deviceId, phone } = await kidPhone();
    const bApp2 = await s.connectApp(bobToken);
    // Not on the phone's list: denied, and no voicemail either.
    bApp2.write({ t: "call.dial", deviceId });
    const denied = await ended(bApp2);
    expect(denied).toMatchObject({ reason: "denied" });
    expect(denied.voicemail).toBeUndefined();
    // Listed but may not call the phone: the same.
    await allow(deviceId, bob.id, "Uncle Bob", { canCallDevice: false });
    bApp2.write({ t: "call.dial", deviceId });
    expect((await ended(bApp2)).voicemail).toBeUndefined();
    // Allowed: the phone is busy (handset up) → offer; then the guardian revokes: refused.
    await allow(deviceId, bob.id, "Uncle Bob", {});
    phone.write({ t: "hook", state: "up" });
    await vi.waitFor(() => expect(phone.sent.length).toBeGreaterThan(0));
    bApp2.write({ t: "call.dial", deviceId });
    const busy = await ended(bApp2);
    expect(busy).toMatchObject({ reason: "busy" });
    await allow(deviceId, bob.id, "Uncle Bob", { canCallDevice: false });
    expectStatus(await leave(s, busy.voicemail?.ticket as string), 403);
    expect((await s.http("/voicemails", { token: jesse.token })).json).toEqual([]);
    // The phone calling out: a key the phone may not call gives nothing; in quiet hours neither.
    await s.store.setButton(deviceId, 1, bob.id);
    await allow(deviceId, bob.id, "Uncle Bob", { deviceCanCall: false });
    phone.write({ t: "button", index: 1 });
    const out = await phone.nextState("ended");
    expect(out).toMatchObject({ reason: "denied" });
    expect(out.voicemail).toBeUndefined();
    await allow(deviceId, bob.id, "Uncle Bob", {});
    const rules = [{ days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], start: "00:00", end: "23:59" }];
    await s.http("/quiet-hours", { method: "PUT", token: jesse.token, body: { rules } });
    phone.write({ t: "button", index: 1 });
    const quiet = await phone.nextState("ended");
    expect(quiet).toMatchObject({ reason: "denied" });
    expect(quiet.voicemail).toBeUndefined();
  });

  it("the phone records its greeting (MENU → Voicemail), if the guardians let the child", async () => {
    const { jesse, bob, bobToken, deviceId, phone } = await kidPhone();
    await allow(deviceId, bob.id, "Uncle Bob", {});
    phone.write({ t: "greeting.begin", kind: "custom" });
    const t = await phone.next("greeting.ticket");
    expect(t).toMatchObject({ kind: "custom", maxMs: 30_000 });
    const saved = await s.http(`/vm/greeting?ticket=${t.ticket}&durationMs=4000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/webm",
    });
    expectStatus(saved, 201);
    let config = await phone.next("config");
    while (config.greeting?.kind !== "custom") config = await phone.next("config");
    expect(config.greeting).toEqual({ kind: "custom", canRecord: true });
    // A caller whose call goes unanswered hears it.
    phone.write({ t: "hook", state: "up" });
    const bApp2 = await s.connectApp(bobToken);
    bApp2.write({ t: "call.dial", deviceId });
    const end = await ended(bApp2);
    expect(await greeting(s, end.voicemail?.ticket as string)).toMatchObject({
      status: 200,
      kind: "custom",
      bytes: new Uint8Array([1, 2, 3]),
    });
    // A greeting ticket isn't a voicemail ticket, and it's single use.
    expectStatus(await leave(s, t.ticket), 404);
    // The guardians turn it off: the phone may no longer change it.
    expectStatus(
      await s.http(`/devices/${deviceId}/voicemail`, {
        method: "PATCH",
        token: jesse.token,
        body: { childGreeting: false },
      }),
      204,
    );
    phone.write({ t: "greeting.begin", kind: "name" });
    expect(await phone.next("greeting.done")).toEqual({
      t: "greeting.done",
      result: "not_allowed",
      kind: "custom",
    });
    phone.write({ t: "greeting.reset" });
    expect(await phone.next("greeting.done")).toMatchObject({ result: "not_allowed" });
    // Guardians reset it from the app.
    expectStatus(
      await s.http(`/devices/${deviceId}/greeting`, { method: "DELETE", token: jesse.token }),
      204,
    );
    expect(
      (await s.http(`/devices/${deviceId}/voicemail`, { token: jesse.token })).json,
    ).toMatchObject({ childGreeting: false, greeting: { kind: "default" }, ringSeconds: 25 });
    // Bob isn't a guardian: not his to change.
    expectStatus(await s.http(`/devices/${deviceId}/voicemail`, { token: bobToken }), 404);
  });
});

describe("greetings", () => {
  it("record just your name: the caller gets it; reset brings back the default", async () => {
    const { bob, bobToken, jApp, bApp } = await household();
    const put = (kind: string, bytes: number, durationMs = 2000) =>
      s.http(`/voicemail/greeting?kind=${kind}&durationMs=${durationMs}`, {
        method: "PUT",
        token: bobToken,
        raw: new Uint8Array(bytes).fill(9),
        type: "audio/webm",
      });
    expectStatus(await put("name", 2 * 1024 * 1024), 413);
    expectStatus(await put("shout", 10), 400);
    expectStatus(await put("name", 40, 9000), 204);
    expect((await s.http("/voicemail/settings", { token: bobToken })).json).toMatchObject({
      greeting: { kind: "name", durationMs: 3000 }, // capped at 3 s
      ringSeconds: 25,
      name: "Bob",
    });
    const own = await s.api.request("/voicemail/greeting/audio", {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(own.headers.get("olp-greeting")).toBe("name");
    jApp.write({ t: "call.user", userId: bob.id });
    const { callId } = await bApp.next("call.ringing");
    bApp.write({ t: "call.hangup", callId });
    const ticket = (await ended(jApp)).voicemail?.ticket as string;
    expect(await greeting(s, ticket)).toMatchObject({ status: 200, kind: "name" });
    // Replaced greetings don't leave audio behind; a reset removes it.
    expectStatus(await put("custom", 50), 204);
    expect(await greeting(s, ticket)).toMatchObject({ kind: "custom" });
    expect([...s.blobs.keys()].filter((k) => k.startsWith("greeting/"))).toHaveLength(1);
    expectStatus(await s.http("/voicemail/greeting", { method: "DELETE", token: bobToken }), 204);
    expect(await greeting(s, ticket)).toMatchObject({ status: 204, kind: "default" });
    expect([...s.blobs.keys()].filter((k) => k.startsWith("greeting/"))).toEqual([]);
    expect(await greeting(s, "not-a-ticket-at-all")).toMatchObject({ status: 404 });
  });
});

describe("Lounge phones", () => {
  it("a person at a Lounge phone gets voicemail in their own inbox, never the shared phone", async () => {
    const { jesse, bob, bobToken, jApp, bApp } = await household();
    const lounge = await s.pairDevice(jesse.token, "Lobby", { kind: "lounge" });
    const loungeId = lounge.deviceId as string;
    const phone = await s.connectDevice(loungeId, lounge.key?.pair as CryptoKeyPair);
    const idle = await phone.next("lounge.idle");
    bApp.write({ t: "lounge.claim", deviceId: loungeId, nonce: idle.nonce });
    const challenge = await phone.next("lounge.challenge");
    phone.write({ t: "lounge.press", index: challenge.index });
    await phone.next("lounge.session");
    // Jesse calls Bob: it rings at the Lounge phone (and his app); nobody answers.
    jApp.write({ t: "call.user", userId: bob.id });
    await phone.next("call.ringing");
    s.timers.advance(RING_TIMEOUT_MS);
    const end = await ended(jApp);
    expectStatus(await leave(s, end.voicemail?.ticket as string), 201);
    expect((await s.http("/voicemails", { token: bobToken })).json).toMatchObject([
      { toUser: bob.id, deviceId: null },
    ]);
    expect((await s.store.listVoicemails(jesse.household.id)).map((v) => v.deviceId)).toEqual([
      null,
    ]);
    expect(phone.all("config").every((c) => !c.missed)).toBe(true);
    // The Lounge phone itself takes no messages and has no greeting.
    phone.write({ t: "greeting.begin", kind: "name" });
    expect(await phone.next("greeting.done")).toMatchObject({ result: "not_allowed" });
    expect(phone.all("config").every((c) => c.greeting === undefined)).toBe(true);
  });
});

describe("across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test");
    b = await net.server("b.test");
  });

  async function connect(
    sa: TestServer,
    x: { token: string },
    sb: TestServer,
    y: { token: string; address: string },
  ) {
    expectStatus(await sa.http("/connections", { token: x.token, body: { to: y.address } }), 202);
    const inbox = await sb.http("/connections", { token: y.token });
    const req = inbox.json.connections[0];
    expectStatus(
      await sb.http(`/connections/${req.id}/accept`, { method: "POST", token: y.token }),
      200,
    );
    const mine = (await sa.http("/connections", { token: x.token })).json.connections[0];
    return { aSide: mine.id as string, bSide: req.id as string };
  }

  it("no answer across servers: their name greeting, then the message in their inbox", async () => {
    const jesse = await a.person("jesse", "Jesse");
    const bob = await b.person("bob", "Bob");
    const ids = await connect(a, jesse, b, bob);
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    expectStatus(
      await b.http("/voicemail/greeting?kind=name&durationMs=1500", {
        method: "PUT",
        token: bob.token,
        raw: new Uint8Array([4, 4, 4]),
        type: "audio/ogg",
      }),
      204,
    );
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    await bApp.next("call.ringing");
    net.timers.advance(RING_TIMEOUT_MS); // Bob's server decides it's unanswered
    const end = await ended(jApp);
    expect(end).toMatchObject({ reason: "timeout", voicemail: { name: "Bob" } });
    const ticket = end.voicemail?.ticket as string;
    expect(await greeting(a, ticket)).toMatchObject({
      status: 200,
      kind: "name",
      bytes: new Uint8Array([4, 4, 4]),
    });
    expectStatus(await leave(a, ticket), 201);
    expect(await bApp.next("voicemail.inbox")).toMatchObject({ from: "Jesse" });
    expect((await b.http("/voicemails", { token: bob.token })).json).toMatchObject([
      { toUser: bob.user.id, fromLabel: "Jesse", fromAddress: "jesse@a.test", fromUser: null },
    ]);
    expect((await b.store.callLog(bob.account.id, "jesse@a.test"))[0]?.voicemailId).toBeTruthy();
  });

  it("fetches a greeting only with an active connection", async () => {
    const jesse = await a.person("jesse", "Jesse");
    const eve = await a.person("eve", "Eve");
    const bob = await b.person("bob", "Bob");
    const ids = await connect(a, jesse, b, bob);
    await b.http("/voicemail/greeting?kind=custom", {
      method: "PUT",
      token: bob.token,
      raw: new Uint8Array([1]),
      type: "audio/webm",
    });
    const ask = (who: { account: { id: string; handle: string; name: string } }) =>
      fedFetch(a.env, "b.test", "/greeting", {
        json: {
          from: { handle: who.account.handle, id: who.account.id, name: who.account.name },
          to: { kind: "person", handle: "bob" },
        },
      }).then(
        (r) => r.status,
        (e: Error) => e.message,
      );
    expect(await ask(jesse)).toBe(200);
    // Eve isn't connected with Bob: refused (and nothing about Bob leaks).
    expect(await ask(eve)).toMatch(/403/);
    // An unsigned request is refused outright.
    const unsigned = await b.root.fetch(
      new Request("https://b.test/fed/v1/greeting", {
        method: "POST",
        body: JSON.stringify({
          from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
          to: { kind: "person", handle: "bob" },
        }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(unsigned.status).toBe(401);
    // Once Bob disconnects, Jesse gets nothing either.
    expectStatus(
      await b.http(`/connections/${ids.bSide}`, { method: "DELETE", token: bob.token }),
      204,
    );
    await vi.waitFor(async () => expect(await ask(jesse)).toMatch(/403/));
  });
});
