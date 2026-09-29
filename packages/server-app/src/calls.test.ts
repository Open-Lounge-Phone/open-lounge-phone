import type { Weekday } from "@openloungephone/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STREAM_IDLE_MS } from "./fedStream.ts";
import { expectStatus, type FakeConn, Network, type TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

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

/** Rings, answers, relays offer/answer/ICE, and checks both sides are active. */
async function talk(caller: FakeConn, callee: FakeConn, callId: string) {
  callee.write({ t: "call.answer", callId });
  const [cfgA, cfgB] = [await caller.next("rtc.config"), await callee.next("rtc.config")];
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
  expect(await callee.next("rtc.sdp")).toMatchObject({ type: "offer", sdp: "v=0 offer" });
  caller.write({ t: "rtc.ice", callId, candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 });
  expect(await callee.next("rtc.ice")).toMatchObject({ candidate: "candidate:1" });
  callee.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 answer" });
  expect(await caller.next("rtc.sdp")).toMatchObject({ type: "answer" });
  await caller.nextState("active");
  await callee.nextState("active");
  return { cfgA, cfgB };
}

describe("calls across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  let ids: { aSide: string; bSide: string };
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", {
      env: {
        iceServers: async () => [{ urls: "turn:turn.a.test", username: "a", credential: "a" }],
      },
    });
    b = await net.server("b.test", {
      env: {
        iceServers: async () => [{ urls: "turn:turn.b.test", username: "b", credential: "b" }],
      },
    });
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
    ids = await connect(a, jesse, b, bob);
  });

  it("rings, connects with each side's own TURN, relays signaling, and hangs up", async () => {
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const ringing = await bApp.next("call.ringing");
    expect(ringing.from.label).toBe("Jesse");
    expect((await jApp.nextState("ringing")).callId).toBe(ringing.callId);
    const { cfgA, cfgB } = await talk(jApp, bApp, ringing.callId);
    expect(cfgA.iceServers[0]?.urls).toBe("turn:turn.a.test");
    expect(cfgB.iceServers[0]?.urls).toBe("turn:turn.b.test");
    // One stream between the two servers carried it all; b dialed it (it spoke first).
    expect(net.streams).toEqual([{ from: "b.test", to: "a.test", closed: false }]);
    net.timers.advance(90_000);
    bApp.write({ t: "call.hangup", callId: ringing.callId });
    expect(await jApp.nextState("ended")).toMatchObject({ reason: "hangup" });
    await bApp.nextState("ended");
    // Each server logs its own person's side, keyed by the other's address (buddy timeline).
    await vi.waitFor(async () =>
      expect(await a.store.callLog(jesse.account.id, "bob@b.test")).toMatchObject([
        {
          direction: "out",
          peerLabel: "Bob",
          answered: true,
          durationMs: 90_000,
          endReason: "hangup",
        },
      ]),
    );
    expect(await b.store.callLog(bob.account.id, "jesse@a.test")).toMatchObject([
      { direction: "in", peerLabel: "Jesse", answered: true, durationMs: 90_000 },
    ]);
  });

  it("closes the idle stream after a minute, and reopens it for the next call", async () => {
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const { callId } = await bApp.next("call.ringing");
    await talk(jApp, bApp, callId);
    jApp.write({ t: "call.hangup", callId });
    await bApp.nextState("ended");
    await vi.waitFor(() => expect(b.links.link("a.test").activeCalls()).toEqual([]));
    // Idle but not yet for a minute: still open.
    net.timers.advance(STREAM_IDLE_MS - 1000);
    expect(net.streams[0]?.closed).toBe(false);
    net.timers.advance(1000);
    expect(net.streams[0]?.closed).toBe(true);
    await vi.waitFor(() => expect(a.links.link("b.test").open).toBe(false));
    expect(b.links.link("a.test").open).toBe(false);
    // The next call dials a fresh stream.
    bApp.write({ t: "call.connection", connectionId: ids.bSide });
    const again = await jApp.next("call.ringing");
    expect(again.from.label).toBe("Bob");
    jApp.write({ t: "call.answer", callId: again.callId });
    await bApp.nextState("connecting");
    expect(net.streams.filter((s) => !s.closed)).toHaveLength(1);
  });

  it("the callee's server decides: no connection, blocked, unavailable, offline, busy", async () => {
    const jApp = await a.connectApp(jesse.token);
    const dial = async (connectionId: string) => {
      jApp.write({ t: "call.connection", connectionId });
      return (await jApp.nextState("ended")).reason;
    };
    expect(await dial(ids.aSide)).toBe("unreachable"); // Bob has no app or phone open
    const bApp = await b.connectApp(bob.token);
    bApp.write({ t: "presence.set", available: false });
    await vi.waitFor(async () =>
      expect((await b.store.availability(bob.household.id)).get(bob.user.id)).toBe(false),
    );
    expect(await dial(ids.aSide)).toBe("unavailable");
    bApp.write({ t: "presence.set", available: true });
    // A server that forges a call without a connection is refused.
    const carol = await a.person("carol", "Carol");
    const forged = await b.env.calls?.receive("a.test", {
      callId: "call_forged_000000",
      from: { handle: "carol", id: carol.account.id, name: "Carol" },
      to: { kind: "person", handle: "bob" },
    });
    expect(forged).toEqual({ state: "ended", reason: "denied" });
    // Bob blocks Jesse's whole server: denied, even with the connection row gone quiet.
    const bRow = ids.bSide;
    expectStatus(
      await b.http(`/connections/${bRow}/block`, { method: "POST", token: bob.token }),
      204,
    );
    const direct = await b.env.calls?.receive("a.test", {
      callId: "call_after_block_0",
      from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
      to: { kind: "person", handle: "bob" },
    });
    expect(direct).toEqual({ state: "ended", reason: "denied" });
    expect(bApp.all("call.ringing")).toEqual([]);
  });

  it("a server block wins over an active connection", async () => {
    await b.connectApp(bob.token);
    const call = (callId: string) =>
      b.env.calls?.receive("a.test", {
        callId,
        from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
        to: { kind: "person", handle: "bob" },
      });
    expect(await call("call_before_block_")).toEqual({ state: "ringing" });
    expectStatus(
      await b.http("/connections/block-server", { token: bob.token, body: { host: "a.test" } }),
      204,
    );
    expect(await call("call_after_srvblock")).toEqual({ state: "ended", reason: "denied" });
  });

  it("a hub only takes signals for a call from the server that is in it", async () => {
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const { callId } = await bApp.next("call.ringing");
    await b.gateway.remoteSignal(bob.household.id, "c.test", {
      t: "call.state",
      callId,
      state: "ended",
      reason: "hangup",
    });
    expect(bApp.all("call.state").filter((m) => m.state === "ended")).toEqual([]);
    await b.gateway.remoteSignal(bob.household.id, "a.test", {
      t: "call.state",
      callId,
      state: "ended",
      reason: "hangup",
    });
    expect(await bApp.nextState("ended")).toMatchObject({ callId });
  });

  it("ignores signals for calls it doesn't have, or from a server that isn't in the call", async () => {
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const { callId } = await bApp.next("call.ringing");
    // c.test knows the call id and tries to end it.
    const c = await net.server("c.test");
    await c.links.register("b.test", callId, "hh_nobody");
    await c.links.signal("b.test", { t: "call.state", callId, state: "ended", reason: "hangup" });
    await vi.waitFor(() => expect(net.streams.some((s) => s.from === "c.test")).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(bApp.all("call.state").filter((m) => m.state === "ended")).toEqual([]);
    bApp.write({ t: "call.answer", callId });
    await jApp.nextState("connecting");
  });

  it("rejects a stream whose hello isn't signed by the claimed server", async () => {
    const c = await net.server("c.test");
    // c.test dials b.test but claims to be a.test.
    const link = b.links.link("a.test");
    const sent: string[] = [];
    const socket = { send: (t: string) => sent.push(t), close: vi.fn() };
    link.accept(socket);
    await link.receive(
      socket,
      JSON.stringify({
        t: "hello",
        from: "a.test",
        to: "b.test",
        created: Math.floor(net.timers.now / 1000),
        nonce: "nonce-nonce-nonce-1",
        sig: "AAAA",
      }),
    );
    expect(socket.close).toHaveBeenCalledWith(4401, "bad signature");
    expect(sent).toEqual([]);
    void c;
  });

  it("a kid's phone: only people on its allow-list, with its quiet hours, and voicemail", async () => {
    const kid = await b.pairDevice(bob.token, "Kid phone");
    const deviceId = kid.deviceId as string;
    const phone = await b.connectDevice(deviceId, kid.key?.pair as CryptoKeyPair);
    const jApp = await a.connectApp(jesse.token);
    // Not on the allow-list yet: Jesse can't even see it, and a direct call is denied.
    const list = async () =>
      (await a.http("/connections", { token: jesse.token })).json.connections[0].phones;
    expect(await list()).toEqual([]);
    jApp.write({ t: "call.phone", connectionId: ids.aSide, deviceId });
    expect(await jApp.next("error")).toMatchObject({ code: "not_found" });
    const denied = await b.env.calls?.receive("a.test", {
      callId: "call_not_listed_00",
      from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
      to: { kind: "phone", deviceId },
    });
    expect(denied).toEqual({ state: "ended", reason: "denied" });

    // Bob lists Jesse on the kid's phone, key 1.
    const flags = {
      label: "Aunt Jesse",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    };
    const added = await b.http(`/devices/${deviceId}/remote-contacts/${ids.bSide}`, {
      method: "PUT",
      token: bob.token,
      body: flags,
    });
    expectStatus(added, 200);
    await b.http(`/devices/${deviceId}/buttons/1`, {
      method: "PUT",
      token: bob.token,
      body: { userId: added.json.id },
    });
    await vi.waitFor(async () => expect(await list()).toEqual([{ deviceId, label: "Kid phone" }]));

    // Jesse calls the phone: it rings with the label its guardian chose.
    jApp.write({ t: "call.phone", connectionId: ids.aSide, deviceId });
    const ring = await phone.next("call.ringing");
    expect(ring.from.label).toBe("Aunt Jesse");
    phone.write({ t: "hook", state: "up" });
    await talk(jApp, phone, ring.callId);
    phone.write({ t: "call.hangup", callId: ring.callId });
    phone.write({ t: "hook", state: "down" });
    await jApp.nextState("ended");
    await phone.nextState("ended");

    // The phone calls Jesse (key 1): her app shows the phone and its guardian.
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 1 });
    const out = await jApp.next("call.ringing");
    expect(out.from.label).toBe("Kid phone (Bob)");
    jApp.write({ t: "call.hangup", callId: out.callId });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "declined" });
    await jApp.nextState("ended");
    phone.write({ t: "hook", state: "down" });

    // Quiet hours at the kid's home: the call goes to voicemail, which Jesse leaves.
    const rules = [{ days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], start: "00:00", end: "23:59" }];
    await b.http("/quiet-hours", { method: "PUT", token: bob.token, body: { rules } });
    jApp.write({ t: "call.phone", connectionId: ids.aSide, deviceId });
    expect(await jApp.nextState("ended")).toMatchObject({ reason: "voicemail" });
    expect(phone.all("call.ringing")).toHaveLength(1);
    const bobApp = await b.connectApp(bob.token);
    const vm = await a.http(
      `/connections/${ids.aSide}/voicemail?deviceId=${deviceId}&durationMs=2000`,
      {
        token: jesse.token,
        raw: new Uint8Array(1000).fill(7),
        type: "audio/webm",
      },
    );
    expectStatus(vm, 201);
    expect(await bobApp.next("voicemail.new")).toMatchObject({ deviceId, from: "Aunt Jesse" });
    const inbox = await b.http("/voicemails", { token: bob.token });
    expect(inbox.json).toMatchObject([
      { fromLabel: "Aunt Jesse", fromUser: null, durationMs: 2000 },
    ]);

    // Someone else Bob is connected with, but who isn't on this phone's list: no call, no voicemail.
    const carol = await a.person("carol", "Carol");
    await connect(a, carol, b, bob);
    const carolParty = { handle: "carol", id: carol.account.id, name: "Carol" };
    expect(
      await b.env.calls?.receive("a.test", {
        callId: "call_carol_to_kid_",
        from: carolParty,
        to: { kind: "phone", deviceId },
      }),
    ).toEqual({ state: "ended", reason: "denied" });
    const { receiveVoicemail } = await import("./connections.ts");
    const rec = { mime: "audio/webm", audio: new ArrayBuffer(8), durationMs: 1 };
    expect(
      await receiveVoicemail(b.env, b.gateway, { ...carolParty, host: "a.test" }, deviceId, rec),
    ).toBe(false);
    // Listed but not allowed to call the phone: no voicemail either.
    await b.http(`/devices/${deviceId}/remote-contacts/${ids.bSide}`, {
      method: "PUT",
      token: bob.token,
      body: { ...flags, canCallDevice: false },
    });
    const jesseParty = { handle: "jesse", id: jesse.account.id, name: "Jesse", host: "a.test" };
    expect(await receiveVoicemail(b.env, b.gateway, jesseParty, deviceId, rec)).toBe(false);

    // Off the allow-list: no more calls, no more voicemail, and it's gone from her list.
    await b.http(`/devices/${deviceId}/contacts/${added.json.id}`, {
      method: "DELETE",
      token: bob.token,
    });
    await vi.waitFor(async () => expect(await list()).toEqual([]));
    const late = await a.http(`/connections/${ids.aSide}/voicemail?deviceId=${deviceId}`, {
      token: jesse.token,
      raw: new Uint8Array(10),
      type: "audio/webm",
    });
    expectStatus(late, 404);
    const forged = await b.root.fetch(
      new Request(
        `https://b.test/fed/v1/voicemail?to=${deviceId}&from=jesse&fromId=${jesse.account.id}&name=J`,
        {
          method: "POST",
          body: new Uint8Array(10),
          headers: { "content-type": "audio/webm" },
        },
      ),
    );
    expect(forged.status).toBe(401);
  });

  it("shares availability only with opt-in, and only with connections", async () => {
    const seen = async () =>
      (await a.http("/connections", { token: jesse.token })).json.connections[0].presence;
    const bApp = await b.connectApp(bob.token);
    await Promise.all(b.background);
    expect(await seen()).toBeNull();
    expectStatus(
      await b.http("/account", {
        method: "PATCH",
        token: bob.token,
        body: { sharePresence: true },
      }),
      200,
    );
    expect(await seen()).toMatchObject({ online: true, available: true });
    bApp.write({ t: "presence.set", available: false });
    await vi.waitFor(async () => {
      await Promise.all(b.background);
      expect(await seen()).toMatchObject({ online: true, available: false });
    });
    // Someone Bob isn't connected with learns nothing.
    const eve = await a.person("eve");
    const eveList = (await a.http("/connections", { token: eve.token })).json.connections;
    expect(eveList).toEqual([]);
    const presencePosts = net.requests.filter((r) => r.url.endsWith("/fed/v1/presence"));
    expect(presencePosts.length).toBeGreaterThan(0);
    expect(presencePosts.every((r) => r.url.startsWith("https://a.test/"))).toBe(true);
  });

  it("coalesces a burst of presence changes and still delivers the final state", async () => {
    const seen = async () =>
      (await a.http("/connections", { token: jesse.token })).json.connections[0].presence;
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.all(b.background);
    };
    const bApp = await b.connectApp(bob.token);
    await b.http("/account", { method: "PATCH", token: bob.token, body: { sharePresence: true } });
    // Well over the per-window limit, ending on "available".
    for (const available of [false, true, false, true, false, true, false]) {
      bApp.write({ t: "presence.set", available });
      await vi.waitFor(async () => {
        await settle();
        expect(
          (await b.store.availability(bob.household.id)).get(bob.user.id),
          "applied locally",
        ).toBe(available);
      });
    }
    await settle();
    // The last change landed in a full window: it waits instead of being dropped.
    expect(await seen()).toMatchObject({ available: true });
    const posts = () => net.requests.filter((r) => r.url.endsWith("/fed/v1/presence")).length;
    const before = posts();
    net.timers.advance(10_000); // the window opens; the hub's wake-up sends the latest state
    await vi.waitFor(async () => {
      await settle();
      expect(await seen()).toMatchObject({ online: true, available: false });
    });
    expect(posts()).toBe(before + 1); // one trailing send, not one per change
    expect(await b.store.connections.nextPresenceDue(bob.household.id)).toBeUndefined();
  });
});

describe("calls between households on one server", () => {
  it("connects two households through a connection, like a call between servers", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const jesse = await a.person("jesse", "Jesse");
    const bob = await a.person("bob", "Bob");
    const ids = await connect(a, jesse, a, bob);
    const jApp = await a.connectApp(jesse.token);
    const bApp = await a.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const ring = await bApp.next("call.ringing");
    expect(ring.from.label).toBe("Jesse");
    await talk(jApp, bApp, ring.callId);
    jApp.write({ t: "call.hangup", callId: ring.callId });
    await bApp.nextState("ended");
    expect(net.streams).toEqual([]); // no network involved
  });
});

describe("Lounge phones across servers", () => {
  it("a guest's home server vouches; key proof; their speed-dial is dialed through their server", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const b = await net.server("b.test");
    const jesse = await a.person("jesse", "Jesse");
    const carol = await a.person("carol", "Carol");
    const bob = await b.person("bob", "Bob");
    await connect(a, jesse, b, bob);
    await connect(a, jesse, a, carol);
    const lobby = await b.pairDevice(bob.token, "Lobby", { kind: "lounge" });
    const phone = await b.connectDevice(lobby.deviceId as string, lobby.key?.pair as CryptoKeyPair);
    const deviceId = lobby.deviceId as string;
    const idle = await phone.next("lounge.idle");
    const claim = (nonce: string) =>
      a.http("/lounge/remote", { token: jesse.token, body: { host: "b.test", deviceId, nonce } });

    // Off by default: the space must let guests in.
    expect((await claim(idle.nonce)).json).toMatchObject({ step: "failed", reason: "not_found" });
    expectStatus(
      await b.http("/lounge/settings", { method: "PUT", token: bob.token, body: { guests: true } }),
      204,
    );
    const jApp = await a.connectApp(jesse.token);
    const started = await claim(idle.nonce);
    expect(started.json).toMatchObject({ step: "press_key" });
    // The code was single use.
    expect((await claim(idle.nonce)).json).toMatchObject({ step: "failed", reason: "expired" });
    const challenge = phone.all("lounge.challenge").at(-1);
    phone.write({ t: "lounge.press", index: challenge?.index as number });
    expect(await phone.next("lounge.session")).toMatchObject({ name: "Jesse" });
    const progress = await jApp.next("lounge.progress");
    expect(progress).toMatchObject({ deviceId, step: "started", host: "b.test" });
    await vi.waitFor(() =>
      expect(phone.all("config").at(-1)?.buttons).toEqual([
        { index: 0, label: "Bob" },
        { index: 1, label: "Carol" },
      ]),
    );

    // Key 1 = Carol, on Jesse's server (another household there): a relayed call.
    const cApp = await a.connectApp(carol.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 1 });
    const ring = await cApp.next("call.ringing");
    expect(ring.from.label).toBe("Jesse");
    const outId = (await phone.nextState("ringing")).callId;
    cApp.write({ t: "call.answer", callId: ring.callId });
    await phone.next("rtc.config");
    await phone.nextState("connecting");
    phone.write({ t: "rtc.sdp", callId: outId, type: "offer", sdp: "v=0 lounge" });
    expect(await cApp.next("rtc.sdp")).toMatchObject({ type: "offer", sdp: "v=0 lounge" });
    cApp.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 back" });
    expect(await phone.next("rtc.sdp")).toMatchObject({ type: "answer", callId: outId });
    await phone.nextState("active");
    phone.write({ t: "call.hangup", callId: outId });
    await cApp.nextState("ended");
    phone.write({ t: "hook", state: "down" });

    // Key 0 = Bob, who is on the Lounge phone's own server: still placed by Jesse's server.
    const bApp = await b.connectApp(bob.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 0 });
    expect((await bApp.next("call.ringing")).from.label).toBe("Jesse");

    // Another server can't make Jesse's server dial for her.
    const c = await net.server("c.test");
    const forged = await b.env.store.connections.pinnedKey("a.test");
    expect(forged).toBeDefined();
    const res = await a.root.fetch(
      new Request("https://a.test/fed/v1/lounge/dial", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
    const { receiveGuestDial } = await import("./fedCalls.ts");
    expect(
      await receiveGuestDial(a.env, a.gateway, "c.test", {
        callId: "call_forged_lounge",
        for: "jesse",
        deviceId,
        deviceLabel: "Lobby",
        to: "carol@a.test",
      }),
    ).toEqual({ state: "ended", reason: "denied" });
    void c;

    // Only people she's (still) connected with: once she blocks Carol, that key is dead.
    const carolRow = (await a.http("/connections", { token: jesse.token })).json.connections.find(
      (x: { address: string }) => x.address === "carol@a.test",
    );
    await a.http(`/connections/${carolRow.id}/block`, { method: "POST", token: jesse.token });
    expect(
      await receiveGuestDial(a.env, a.gateway, "b.test", {
        callId: "call_blocked_carol",
        for: "jesse",
        deviceId,
        deviceLabel: "Lobby",
        to: "carol@a.test",
      }),
    ).toEqual({ state: "ended", reason: "denied" });

    // Jesse leaves from her own app: the phone forgets her, her server stops vouching.
    expectStatus(
      await a.http("/lounge/remote/leave", {
        token: jesse.token,
        body: { host: "b.test", deviceId },
      }),
      204,
    );
    expect(await phone.next("lounge.ended")).toMatchObject({ reason: "left" });
    expect(await a.store.loungeAwayState(jesse.account.id, "b.test", deviceId)).toBe("ended");
    expect(
      await receiveGuestDial(a.env, a.gateway, "b.test", {
        callId: "call_after_leaving",
        for: "jesse",
        deviceId,
        deviceLabel: "Lobby",
        to: "carol@a.test",
      }),
    ).toEqual({ state: "ended", reason: "denied" });
    // Guardians see that a guest used it.
    const history = (await b.http("/lounge", { token: bob.token })).json.history;
    expect(history[0]).toMatchObject({
      userName: "Jesse",
      guest: "jesse@a.test",
      endReason: "left",
    });
  });
});

describe("ringing a person everywhere they are", () => {
  it("rings the callee's other spaces: apps, own phone and the Lounge phone they're at", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const b = await net.server("b.test");
    const jesse = await a.person("jesse", "Jesse");
    const bob = await b.person("bob", "Bob");
    const ids = await connect(a, jesse, b, bob);
    // Bob is also in Carol's studio (a team space) on b.test.
    const carol = await b.person("carol", "Carol", "team");
    const bobThere = await b.store.createUser(
      { householdId: carol.household.id, name: "Bob", role: "contact", accountId: bob.account.id },
      net.timers.now + 1,
    );
    const bobStudio = await b.store.createSession(bobThere.id, net.timers.now);
    const jApp = await a.connectApp(jesse.token);

    // Only his studio app is open: the call still reaches him there.
    const studioApp = await b.connectApp(bobStudio);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const ring = await studioApp.next("call.ringing");
    expect(ring.from.label).toBe("Jesse");
    // Each leg has its own call id: Jesse's, and the one Bob's studio sees.
    const mine = (await jApp.nextState("ringing")).callId;
    studioApp.write({ t: "call.answer", callId: ring.callId });
    await jApp.nextState("connecting");
    jApp.write({ t: "rtc.sdp", callId: mine, type: "offer", sdp: "v=0 j" });
    expect(await studioApp.next("rtc.sdp")).toMatchObject({ callId: ring.callId, sdp: "v=0 j" });
    studioApp.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 b" });
    expect(await jApp.next("rtc.sdp")).toMatchObject({ callId: mine, sdp: "v=0 b" });
    await jApp.nextState("active");
    jApp.write({ t: "call.hangup", callId: mine });
    await studioApp.nextState("ended");

    // His own phone in the studio and the studio's Lounge phone he's at ring too, alongside his
    // home app; answering on one stops the others.
    const own = await b.pairDevice(bobStudio, "Bob's desk", { forMe: true });
    const desk = await b.connectDevice(own.deviceId as string, own.key?.pair as CryptoKeyPair);
    const lobby = await b.pairDevice(carol.token, "Lobby", { kind: "lounge" });
    const lounge = await b.connectDevice(
      lobby.deviceId as string,
      lobby.key?.pair as CryptoKeyPair,
    );
    const idle = await lounge.next("lounge.idle");
    studioApp.write({ t: "lounge.claim", deviceId: lobby.deviceId as string, nonce: idle.nonce });
    const challenge = await lounge.next("lounge.challenge");
    lounge.write({ t: "lounge.press", index: challenge.index });
    await lounge.next("lounge.session");
    const homeApp = await b.connectApp(bob.token);

    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const second = (await jApp.nextState("ringing")).callId;
    const atHome = await homeApp.next("call.ringing");
    const atDesk = await desk.next("call.ringing");
    const atLounge = await lounge.next("call.ringing");
    expect([atDesk.from.label, atLounge.from.label]).toEqual(["Jesse", "Jesse"]);
    lounge.write({ t: "hook", state: "up" });
    lounge.write({ t: "call.answer", callId: atLounge.callId });
    await jApp.nextState("connecting");
    expect((await homeApp.nextState("ended")).callId).toBe(atHome.callId);
    expect((await desk.nextState("ended")).callId).toBe(atDesk.callId);
    jApp.write({ t: "rtc.sdp", callId: second, type: "offer", sdp: "v=0 x" });
    expect(await lounge.next("rtc.sdp")).toMatchObject({ callId: atLounge.callId, sdp: "v=0 x" });
    lounge.write({ t: "rtc.sdp", callId: atLounge.callId, type: "answer", sdp: "v=0 y" });
    await jApp.nextState("active");
    lounge.write({ t: "call.hangup", callId: atLounge.callId });
    await jApp.nextState("ended");
  });

  it("a decline anywhere ends the call; nothing reachable anywhere is unreachable", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const b = await net.server("b.test");
    const jesse = await a.person("jesse", "Jesse");
    const bob = await b.person("bob", "Bob");
    const ids = await connect(a, jesse, b, bob);
    const carol = await b.person("carol", "Carol", "team");
    const bobThere = await b.store.createUser(
      { householdId: carol.household.id, name: "Bob", role: "contact", accountId: bob.account.id },
      net.timers.now + 1,
    );
    const jApp = await a.connectApp(jesse.token);
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    expect((await jApp.nextState("ended")).reason).toBe("unreachable");
    const homeApp = await b.connectApp(bob.token);
    const studioApp = await b.connectApp(await b.store.createSession(bobThere.id, net.timers.now));
    jApp.write({ t: "call.connection", connectionId: ids.aSide });
    const r = await studioApp.next("call.ringing");
    const h = await homeApp.next("call.ringing");
    studioApp.write({ t: "call.hangup", callId: r.callId });
    expect((await jApp.nextState("ended")).reason).toBe("declined");
    expect((await homeApp.nextState("ended")).callId).toBe(h.callId);
  });

  it("rings a Lounge guest at the phone they're on elsewhere, and at their own apps", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const b = await net.server("b.test");
    const jesse = await a.person("jesse", "Jesse");
    const carol = await a.person("carol", "Carol");
    const bob = await b.person("bob", "Bob");
    const toJesse = await connect(a, carol, a, jesse);
    const bobToJesse = await connect(b, bob, a, jesse);
    const lobby = await b.pairDevice(bob.token, "Lobby", { kind: "lounge" });
    const phone = await b.connectDevice(lobby.deviceId as string, lobby.key?.pair as CryptoKeyPair);
    const deviceId = lobby.deviceId as string;
    await b.http("/lounge/settings", { method: "PUT", token: bob.token, body: { guests: true } });
    const idle = await phone.next("lounge.idle");
    await a.http("/lounge/remote", {
      token: jesse.token,
      body: { host: "b.test", deviceId, nonce: idle.nonce },
    });
    const challenge = await phone.next("lounge.challenge");
    phone.write({ t: "lounge.press", index: challenge.index });
    await phone.next("lounge.session");
    await vi.waitFor(async () =>
      expect(await a.store.loungeAwayState(jesse.account.id, "b.test", deviceId)).toBe("active"),
    );
    const jApp = await a.connectApp(jesse.token);

    // Carol, on Jesse's own server, calls her: her app and the Lounge phone at b.test both ring.
    const cApp = await a.connectApp(carol.token);
    cApp.write({ t: "call.connection", connectionId: toJesse.aSide });
    const onApp = await jApp.next("call.ringing");
    const onPhone = await phone.next("call.ringing");
    expect([onApp.from.label, onPhone.from.label]).toEqual(["Carol", "Carol"]);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.answer", callId: onPhone.callId });
    const connecting = await cApp.nextState("connecting");
    expect((await jApp.nextState("ended")).callId).toBe(onApp.callId);
    cApp.write({ t: "rtc.sdp", callId: connecting.callId, type: "offer", sdp: "v=0 c" });
    expect(await phone.next("rtc.sdp")).toMatchObject({ callId: onPhone.callId, sdp: "v=0 c" });
    phone.write({ t: "rtc.sdp", callId: onPhone.callId, type: "answer", sdp: "v=0 p" });
    await cApp.nextState("active");
    cApp.write({ t: "call.hangup", callId: connecting.callId });
    await phone.nextState("ended");
    phone.write({ t: "hook", state: "down" });

    // Bob, on the Lounge phone's own server, calls her: it rings there too (through her server).
    const bApp = await b.connectApp(bob.token);
    bApp.write({ t: "call.connection", connectionId: bobToJesse.aSide });
    await new Promise((r) => setTimeout(r, 100));
    await jApp.next("call.ringing");
    expect((await phone.next("call.ringing")).from.label).toBe("Bob");

    // Only her own server can ring her there.
    const c = await net.server("c.test");
    expect(
      await b.env.calls?.receive("c.test", {
        callId: "call_forged_guest",
        from: { handle: "jesse", id: jesse.account.id, name: "Jesse" },
        to: { kind: "guest", deviceId },
      }),
    ).toEqual({ state: "ended", reason: "unreachable" });
    void c;
  });
});
