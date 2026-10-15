// Missed calls (docs/phone-ux.md "Missed calls"): a call that rang and nobody answered, with no
// message, shows on the callee's phones (those that list `missed-calls`) and apps until cleared;
// a message moves it to voicemail; phones call back as they'd dial.
import { describe, expect, it } from "vitest";
import { RING_TIMEOUT_MS } from "./env.ts";
import { expectStatus, type FakeConn, TestServer } from "./testkit.ts";

const AUDIO = new Uint8Array(900).fill(5);

async function setup() {
  const s = new TestServer({ publicUrl: "https://home.test" });
  const jesse = await s.person("jesse", "Jesse");
  const bob = await s.store.createUser(
    { householdId: jesse.household.id, name: "Bob", role: "contact" },
    0,
  );
  const bobToken = await s.store.createSession(bob.id, s.timers.now);
  const kid = await s.pairDevice(jesse.token, "Kid phone");
  if (kid.status !== 201 || !kid.deviceId) throw new Error("pairing failed");
  // Bob may call the kid's phone; the kid may not call Bob.
  expectStatus(
    await s.http(`/devices/${kid.deviceId}/contacts/${bob.id}`, {
      method: "PUT",
      token: jesse.token,
      body: { label: "Bob", canCallDevice: true, deviceCanCall: false, bypassQuietHours: false },
    }),
    204,
  );
  return { s, jesse, bob, bobToken, kid: { id: kid.deviceId, key: kid.key } };
}

/** The phone's latest config (after the ones already consumed). */
async function nextMissed(phone: FakeConn) {
  return (await phone.next("config")).missed ?? [];
}

describe("missed calls on a household phone", () => {
  it("rang and nobody answered: shown on the phone; a message moves it to voicemail", async () => {
    const { s, bobToken, kid } = await setup();
    const now = await s.connectDevice(kid.id, kid.key.pair, ["missed-calls"]);
    const bApp = await s.connectApp(bobToken);
    bApp.write({ t: "call.dial", deviceId: kid.id });
    const { callId } = await now.next("call.ringing");
    s.timers.advance(RING_TIMEOUT_MS);
    const end = await bApp.nextState("ended");
    expect(end).toMatchObject({ callId, reason: "timeout" });
    const missed = await nextMissed(now);
    expect(missed).toEqual([
      expect.objectContaining({ from: "Bob", kind: "call", count: 1, id: expect.any(String) }),
    ]);
    // Bob leaves a message after all: it's voicemail now, not a missed call.
    const ticket = end.voicemail?.ticket as string;
    expectStatus(
      await s.http(`/vm/message?ticket=${encodeURIComponent(ticket)}&durationMs=4000`, {
        raw: AUDIO,
        type: "audio/wav",
      }),
      201,
    );
    const after = await nextMissed(now);
    expect(after).toEqual([expect.objectContaining({ from: "Bob", kind: "voicemail" })]);
  });

  it("only phones that list missed-calls get them; missed.clear clears them", async () => {
    const { s, jesse, kid } = await setup();
    const older = await s.connectDevice(kid.id, kid.key.pair);
    const jApp = await s.connectApp(jesse.token);
    jApp.write({ t: "call.dial", deviceId: kid.id });
    await older.next("call.ringing");
    jApp.write({ t: "call.hangup", callId: (await jApp.nextState("ringing")).callId });
    await jApp.nextState("ended");
    // The caller gave up while it rang: a missed call, but this phone doesn't show those.
    expect(await s.store.missed.list({ deviceId: kid.id })).toHaveLength(1);
    expect(older.all("config").at(-1)?.missed ?? []).toEqual([]);
    const phone = await s.connectDevice(kid.id, kid.key.pair, ["missed-calls"]);
    expect(phone.all("config").at(-1)?.missed).toEqual([
      expect.objectContaining({ from: "Jesse", kind: "call" }),
    ]);
    phone.write({ t: "missed.clear" });
    expect(await nextMissed(phone)).toEqual([]);
    expect(await s.store.missed.list({ deviceId: kid.id })).toEqual([]);
  });

  it("calls back only people on its allow-list it may call", async () => {
    const { s, jesse, bobToken, kid } = await setup();
    const phone = await s.connectDevice(kid.id, kid.key.pair, ["missed-calls"]);
    const jApp = await s.connectApp(jesse.token);
    const bApp = await s.connectApp(bobToken);
    for (const app of [jApp, bApp]) {
      app.write({ t: "call.dial", deviceId: kid.id });
      await phone.next("call.ringing");
      s.timers.advance(RING_TIMEOUT_MS);
      await app.nextState("ended");
      await phone.nextState("ended");
    }
    const missed = phone.all("config").at(-1)?.missed ?? [];
    const fromJesse = missed.find((m) => m.from === "Jesse")?.id as string;
    const fromBob = missed.find((m) => m.from === "Bob")?.id as string;
    expect(fromJesse && fromBob).toBeTruthy();
    // The guardian (on its keys from pairing) rings.
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.back", id: fromJesse });
    const ring = await jApp.next("call.ringing");
    expect(ring.from.label).toBe("Kid phone");
    phone.write({ t: "call.hangup", callId: ring.callId });
    await phone.nextState("ended");
    // Bob may call the phone, but the phone may not call Bob: refused, plainly.
    phone.write({ t: "call.back", id: fromBob });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(bApp.all("call.ringing")).toHaveLength(0);
    // Someone else's missed call isn't this phone's to call back.
    const theirs = await s.store.missed.add({
      householdId: jesse.household.id,
      owner: { accountId: jesse.account.id },
      callId: "c_x",
      fromLabel: "Jesse",
      fromPeer: `user:${jesse.user.id}`,
      at: s.timers.now,
    });
    for (const id of [theirs, "mc_nope"]) {
      phone.write({ t: "call.back", id });
      expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    }
    expect(jApp.all("call.ringing")).toHaveLength(1);
  });
});

describe("a person's missed calls", () => {
  it("in the app and on their own phone, everywhere; declined isn't missed; clear clears", async () => {
    const { s, jesse, bob, bobToken } = await setup();
    const own = await s.pairDevice(jesse.token, "Desk", { forMe: true });
    if (!own.deviceId) throw new Error("pairing failed");
    const desk = await s.connectDevice(own.deviceId, own.key.pair, ["missed-calls"]);
    const jApp = await s.connectApp(jesse.token);
    const bApp = await s.connectApp(bobToken);
    // Declined: Jesse saw it, so it isn't missed.
    bApp.write({ t: "call.user", userId: jesse.user.id });
    const first = await jApp.next("call.ringing");
    jApp.write({ t: "call.hangup", callId: first.callId });
    await bApp.nextState("ended");
    expect((await s.http("/missed", { token: jesse.token })).json.missed).toEqual([]);
    // Bob gives up while it rings (the app and the desk phone): missed.
    bApp.write({ t: "call.user", userId: jesse.user.id });
    const second = await jApp.next("call.ringing");
    await desk.next("call.ringing");
    bApp.write({ t: "call.hangup", callId: second.callId });
    await jApp.next("missed.changed");
    const list = (await s.http("/missed", { token: jesse.token })).json.missed;
    expect(list).toEqual([
      expect.objectContaining({
        kind: "call",
        from: "Bob",
        count: 1,
        callBack: { kind: "user", userId: bob.id },
      }),
    ]);
    const deskMissed = await nextMissed(desk);
    expect(deskMissed).toEqual([expect.objectContaining({ from: "Bob", kind: "call" })]);
    // The desk phone calls back as Jesse.
    desk.write({ t: "hook", state: "up" });
    desk.write({ t: "call.back", id: deskMissed[0]?.id as string });
    const back = await bApp.next("call.ringing");
    // As Jesse, as she would from her app.
    expect(back.from.label).toBe("Jesse");
    bApp.write({ t: "call.hangup", callId: back.callId });
    await desk.nextState("ended");
    // Cleared in the app: gone on the phone too.
    expect((await s.http("/missed/clear", { method: "POST", token: jesse.token })).json).toEqual({
      cleared: 1,
    });
    expect(await nextMissed(desk)).toEqual([]);
    expect((await s.http("/missed", { token: jesse.token })).json.missed).toEqual([]);
    // The export carries it, seen.
    const doc = (await s.http("/account/export", { token: jesse.token })).json;
    expect(doc.missedCalls).toEqual([
      expect.objectContaining({
        peer: `user:${bob.id}`,
        peerLabel: "Bob",
        seenAt: expect.any(String),
      }),
    ]);
  });
});
