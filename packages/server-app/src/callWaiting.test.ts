// Call waiting (docs/phone-ux.md "Call waiting"): a second call to someone in a call rings softly
// where they're talking instead of being refused as busy; answering it holds the first call;
// left alone it goes to voicemail after the usual ring time. The callee's server decides, so it
// works across servers with no new federation message.
import { describe, expect, it } from "vitest";
import { RING_TIMEOUT_MS } from "./env.ts";
import { expectStatus, type FakeConn, Network, TestServer } from "./testkit.ts";

/** Rings, answers and connects a call (offer/answer relayed). */
async function talk(caller: FakeConn, callee: FakeConn, callId: string) {
  callee.write({ t: "call.answer", callId });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
  await callee.next("rtc.sdp");
  callee.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 answer" });
  await caller.nextState("active");
  await callee.nextState("active");
}

async function space() {
  const s = new TestServer({ publicUrl: "https://home.test" });
  const jesse = await s.person("jesse", "Jesse");
  const member = async (name: string) => {
    const user = await s.store.createUser(
      { householdId: jesse.household.id, name, role: "contact" },
      0,
    );
    const token = await s.store.createSession(user.id, s.timers.now);
    return { user, token, app: await s.connectApp(token) };
  };
  return {
    s,
    jesse,
    jApp: await s.connectApp(jesse.token),
    bob: await member("Bob"),
    ana: await member("Ana"),
  };
}

/** Jesse is talking with Bob; returns that call's id. */
async function inCall(jApp: FakeConn, bApp: FakeConn, jesseId: string) {
  bApp.write({ t: "call.user", userId: jesseId });
  const ring = await jApp.next("call.ringing");
  await talk(bApp, jApp, ring.callId);
  return ring.callId;
}

describe("call waiting", () => {
  it("rings softly where they're talking; answering holds the first call", async () => {
    const { jesse, jApp, bob, ana } = await space();
    const first = await inCall(jApp, bob.app, jesse.user.id);
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    const waiting = await jApp.next("call.ringing");
    expect(waiting).toMatchObject({ from: { label: "Ana" }, waiting: true });
    await ana.app.nextState("ringing");
    jApp.write({ t: "call.answer", callId: waiting.callId });
    // Bob is on hold (his phone plays the hold tone); Jesse talks with Ana.
    expect(await bob.app.nextState("active")).toMatchObject({ callId: first, hold: "them" });
    expect(await jApp.nextState("active")).toMatchObject({ callId: first, hold: "you" });
    await ana.app.nextState("connecting");
    expect(await jApp.nextState("connecting")).toMatchObject({ callId: waiting.callId });
    // Ana hangs up; Jesse takes Bob back.
    ana.app.write({ t: "call.hangup", callId: waiting.callId });
    await jApp.nextState("ended");
    jApp.write({ t: "call.hold", callId: first, hold: false });
    const back = await bob.app.nextState("active");
    expect(back.callId).toBe(first);
    expect(back.hold).toBeUndefined();
  });

  it("left alone it goes to voicemail at the usual time; declined at once", async () => {
    const { s, jesse, jApp, bob, ana } = await space();
    await inCall(jApp, bob.app, jesse.user.id);
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    await jApp.next("call.ringing");
    s.timers.advance(RING_TIMEOUT_MS);
    const ended = await ana.app.nextState("ended");
    expect(ended).toMatchObject({ reason: "timeout", voicemail: expect.any(Object) });
    // Still talking with Bob, not held.
    expect(bob.app.all("call.state").some((m) => m.hold === "them")).toBe(false);
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    const again = await jApp.next("call.ringing");
    jApp.write({ t: "call.hangup", callId: again.callId });
    expect(await ana.app.nextState("ended")).toMatchObject({ reason: "declined" });
  });

  it("off in their settings, their call on hold, or a call already waiting: busy", async () => {
    const { s, jesse, jApp, bob, ana } = await space();
    const first = await inCall(jApp, bob.app, jesse.user.id);
    // Off: busy, as before (with the voicemail offer).
    expectStatus(
      await s.http("/call-waiting", { method: "PUT", token: jesse.token, body: { on: false } }),
      200,
    );
    expect((await s.http("/call-waiting", { token: jesse.token })).json).toEqual({ on: false });
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    expect(await ana.app.nextState("ended")).toMatchObject({
      reason: "busy",
      voicemail: expect.any(Object),
    });
    expectStatus(
      await s.http("/call-waiting", { method: "PUT", token: jesse.token, body: { on: true } }),
      200,
    );
    // A call already waiting: a third caller is busy.
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    await jApp.next("call.ringing");
    const carl = await s.store.createUser(
      { householdId: jesse.household.id, name: "Carl", role: "contact" },
      0,
    );
    const cApp = await s.connectApp(await s.store.createSession(carl.id, s.timers.now));
    cApp.write({ t: "call.user", userId: jesse.user.id });
    expect(await cApp.nextState("ended")).toMatchObject({ reason: "busy" });
    // Jesse's call held by her: busy too (she isn't talking to anyone right now).
    s.timers.advance(RING_TIMEOUT_MS);
    await ana.app.nextState("ended");
    jApp.write({ t: "call.hold", callId: first, hold: true });
    await bob.app.nextState("active");
    ana.app.write({ t: "call.user", userId: jesse.user.id });
    expect(await ana.app.nextState("ended")).toMatchObject({ reason: "busy" });
  });
});

describe("call waiting on phones", () => {
  it("a phone that lists call-waiting gets it; one that doesn't is busy", async () => {
    const { s, jesse, bob, ana } = await space();
    const kid = await s.pairDevice(jesse.token, "Kid");
    if (!kid.deviceId) throw new Error("pairing failed");
    for (const who of [bob, ana]) {
      expectStatus(
        await s.http(`/devices/${kid.deviceId}/contacts/${who.user.id}`, {
          method: "PUT",
          token: jesse.token,
          body: {
            label: who.user.name,
            canCallDevice: true,
            deviceCanCall: true,
            bypassQuietHours: false,
          },
        }),
        204,
      );
    }
    const older = await s.connectDevice(kid.deviceId, kid.key.pair);
    bob.app.write({ t: "call.dial", deviceId: kid.deviceId });
    const ring = await older.next("call.ringing");
    older.write({ t: "hook", state: "up" });
    await talk(bob.app, older, ring.callId);
    ana.app.write({ t: "call.dial", deviceId: kid.deviceId });
    expect(await ana.app.nextState("ended")).toMatchObject({ reason: "busy" });
    // The same call on a phone that shows call waiting.
    bob.app.write({ t: "call.hangup", callId: ring.callId });
    await older.nextState("ended");
    const phone = await s.connectDevice(kid.deviceId, kid.key.pair, ["call-waiting"]);
    bob.app.write({ t: "call.dial", deviceId: kid.deviceId });
    const ring2 = await phone.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    await talk(bob.app, phone, ring2.callId);
    ana.app.write({ t: "call.dial", deviceId: kid.deviceId });
    const waiting = await phone.next("call.ringing");
    expect(waiting).toMatchObject({ from: { label: "Ana" }, waiting: true });
    phone.write({ t: "call.answer", callId: waiting.callId });
    expect(await bob.app.nextState("active")).toMatchObject({ hold: "them" });
    await ana.app.nextState("connecting");
    // Its guardians can turn it off for the phone: busy again.
    ana.app.write({ t: "call.hangup", callId: waiting.callId });
    await ana.app.nextState("ended");
    await phone.nextState("ended");
    phone.write({ t: "call.hold", callId: ring2.callId, hold: false });
    await bob.app.nextState("active");
    expectStatus(
      await s.http(`/devices/${kid.deviceId}/call-waiting`, {
        method: "PUT",
        token: jesse.token,
        body: { on: false },
      }),
      200,
    );
    expectStatus(
      await s.http(`/devices/${kid.deviceId}/call-waiting`, {
        method: "PUT",
        token: bob.token,
        body: { on: true },
      }),
      403,
    );
    ana.app.write({ t: "call.dial", deviceId: kid.deviceId });
    expect(await ana.app.nextState("ended")).toMatchObject({ reason: "busy" });
  });

  it("a kids' phone: the allow-list and quiet hours apply as for a first call", async () => {
    const { s, jesse, bob, ana } = await space();
    const kid = await s.pairDevice(jesse.token, "Kid");
    if (!kid.deviceId) throw new Error("pairing failed");
    expectStatus(
      await s.http(`/devices/${kid.deviceId}/contacts/${bob.user.id}`, {
        method: "PUT",
        token: jesse.token,
        body: { label: "Bob", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
      }),
      204,
    );
    const phone = await s.connectDevice(kid.deviceId, kid.key.pair, ["call-waiting"]);
    bob.app.write({ t: "call.dial", deviceId: kid.deviceId });
    const ring = await phone.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    await talk(bob.app, phone, ring.callId);
    // Ana isn't on its allow-list: refused, never rung, as if the phone were free.
    ana.app.write({ t: "call.dial", deviceId: kid.deviceId });
    expect(await ana.app.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(phone.all("call.ringing")).toHaveLength(1);
  });
});

describe("call waiting across servers", () => {
  it("the callee's server decides: a caller elsewhere rings softly, answering holds", async () => {
    const net = new Network();
    const a = await net.server("a.test");
    const b = await net.server("b.test");
    const jesse = await a.person("jesse", "Jesse");
    const bob = await b.person("bob", "Bob");
    expectStatus(
      await a.http("/connections", { token: jesse.token, body: { to: bob.address } }),
      202,
    );
    const inbox = await b.http("/connections", { token: bob.token });
    const req = inbox.json.connections.find(
      (c: { address: string }) => c.address === jesse.address,
    );
    expectStatus(
      await b.http(`/connections/${req.id}/accept`, { method: "POST", token: bob.token }),
      200,
    );
    const ana = await a.store.createUser(
      { householdId: jesse.household.id, name: "Ana", role: "contact" },
      0,
    );
    const aApp = await a.connectApp(await a.store.createSession(ana.id, a.timers.now));
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    // Jesse talks with Ana (same server); Bob calls from b.test.
    aApp.write({ t: "call.user", userId: jesse.user.id });
    const first = await jApp.next("call.ringing");
    await talk(aApp, jApp, first.callId);
    bApp.write({ t: "call.connection", connectionId: req.id });
    const waiting = await jApp.next("call.ringing");
    expect(waiting).toMatchObject({ from: { label: "Bob" }, waiting: true });
    await bApp.nextState("ringing");
    jApp.write({ t: "call.answer", callId: waiting.callId });
    expect(await aApp.nextState("active")).toMatchObject({ hold: "them" });
    await bApp.nextState("connecting");
  });
});
