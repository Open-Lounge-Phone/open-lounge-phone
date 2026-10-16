// A kids' phone's call activity for its guardians (docs/privacy.md): every call in and out,
// answered or not, missed, refused and why, newest first, a page at a time, within the space's
// history retention and with no content.
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, type FakeConn, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

const DAY = 24 * 60 * 60 * 1000;

/** Mom (guardian) with Sam's kids' phone (Mom on key 1), and Dad (a member, not on its list). */
async function home() {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "contact" },
    s.timers.now,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  const paired = await s.pairDevice(mom.token, "Sam's phone");
  const deviceId = paired.deviceId as string;
  const phone = await s.connectDevice(deviceId, paired.key?.pair as CryptoKeyPair);
  return { mom, dad, dadToken, deviceId, phone, key: paired.key?.pair as CryptoKeyPair };
}

type Row = {
  direction: string;
  who: string;
  answered: boolean;
  durationMs: number;
  ended: string;
  refused?: string;
  note?: string;
  voicemail: boolean;
  cursor: string;
  at: number;
};

const activity = async (token: string, deviceId: string, query = "") =>
  s.http(`/devices/${deviceId}/calls${query}`, { token });

/** The phone goes offline (the app has heard so). */
async function offline(phone: FakeConn, app: FakeConn) {
  phone.handler.closed();
  for (;;) {
    const m = await app.next("device.status");
    if (!m.online) return;
  }
}

/** Answers a ringing call on both sides and runs offer/answer until it's active. */
async function talk(caller: FakeConn, callee: FakeConn, callId: string, calleeCallId = callId) {
  callee.write({ t: "call.answer", callId: calleeCallId });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
  await callee.next("rtc.sdp");
  callee.write({ t: "rtc.sdp", callId: calleeCallId, type: "answer", sdp: "v=0 answer" });
  await caller.nextState("active");
}

describe("a kids' phone's call activity", () => {
  it("lists every call in and out, answered, missed and refused with why, newest first", async () => {
    const { mom, dad, dadToken, deviceId, phone } = await home();
    const momApp = await s.connectApp(mom.token);
    // 1. Mom calls; Sam answers; they talk three minutes.
    momApp.write({ t: "call.dial", deviceId });
    const ring = await phone.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    await talk(momApp, phone, ring.callId);
    s.timers.advance(3 * 60 * 1000);
    momApp.write({ t: "call.hangup", callId: ring.callId });
    await phone.nextState("ended");
    await momApp.nextState("ended");
    phone.write({ t: "hook", state: "down" });
    s.timers.advance(1000);
    // 2. Mom calls; nobody answers: a missed call.
    momApp.write({ t: "call.dial", deviceId });
    await phone.next("call.ringing");
    s.timers.advance(60_000);
    await momApp.nextState("ended");
    await phone.nextState("ended");
    s.timers.advance(1000);
    // 3. Dad isn't on the phone's list.
    const dadApp = await s.connectApp(dadToken);
    dadApp.write({ t: "call.dial", deviceId });
    expect(await dadApp.nextState("ended")).toMatchObject({ reason: "denied" });
    s.timers.advance(1000);
    // 4. Sam presses a key with nobody on it.
    phone.write({ t: "button", index: 4 });
    await phone.nextState("ended");
    s.timers.advance(1000);
    // 5. Sam calls Dad during quiet hours (Dad is now on the list, without "during quiet hours").
    await s.store.upsertContact(deviceId, {
      id: dad.id,
      label: "Dad",
      canCallDevice: false,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    await s.store.setButton(deviceId, 1, dad.id);
    expectStatus(
      await s.http("/quiet-hours", {
        method: "PUT",
        token: mom.token,
        body: {
          timezone: "UTC",
          rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
        },
      }),
      204,
    );
    phone.write({ t: "button", index: 1 });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    s.timers.advance(1000);
    // 6. The phone is offline when Mom calls.
    await offline(phone, momApp);
    s.timers.advance(1000);
    momApp.write({ t: "call.dial", deviceId });
    expect(await momApp.nextState("ended")).toMatchObject({ reason: "unreachable" });

    const res = await activity(mom.token, deviceId);
    expectStatus(res, 200);
    const calls = res.json.calls as Row[];
    expect(
      calls.map((c) => [c.direction, c.who, c.answered, c.durationMs, c.ended, c.refused]),
    ).toEqual([
      ["in", "Mom", false, 0, "unreachable", "offline"],
      ["out", "Dad", false, 0, "denied", "quiet_hours"],
      ["out", "Key 5", false, 0, "denied", "not_allowed"],
      ["in", "Dad", false, 0, "denied", "not_allowed"],
      ["in", "Mom", false, 0, "timeout", undefined],
      ["in", "Mom", true, 3 * 60 * 1000, "hangup", undefined],
    ]);
    expect(res.json.more).toBe(false);
    // Nothing about what was said: these fields only.
    expect(Object.keys(calls[5] as object).sort()).toEqual(
      [
        "answered",
        "at",
        "cursor",
        "direction",
        "durationMs",
        "ended",
        "id",
        "voicemail",
        "who",
      ].sort(),
    );
  });

  it("pages back with Show older", async () => {
    const { mom, deviceId, phone } = await home();
    for (let i = 0; i < 5; i++) {
      phone.write({ t: "button", index: 7 });
      await phone.nextState("ended");
      if (i !== 2) s.timers.advance(1000); // two at the same moment, too
    }
    const first = await activity(mom.token, deviceId, "?limit=2");
    expect(first.json.calls).toHaveLength(2);
    expect(first.json.more).toBe(true);
    const seen = [...(first.json.calls as Row[])];
    let cursor = seen[seen.length - 1]?.cursor;
    for (;;) {
      const page = await activity(mom.token, deviceId, `?limit=2&before=${cursor}`);
      seen.push(...(page.json.calls as Row[]));
      cursor = seen[seen.length - 1]?.cursor;
      if (!page.json.more) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((r) => r.cursor)).size).toBe(5);
    const times = seen.map((r) => r.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expectStatus(await activity(mom.token, deviceId, "?before=nope"), 400);
  });

  it("is for guardians, and only for kids' phones", async () => {
    const { mom, dadToken, deviceId } = await home();
    expectStatus(await activity(dadToken, deviceId), 404);
    const other = await s.person("eve", "Eve");
    expectStatus(await activity(other.token, deviceId), 404);
    const mine = await s.pairDevice(mom.token, "Mom's desk", { forMe: true });
    expectStatus(await activity(mom.token, mine.deviceId as string), 404);
  });

  it("keeps to the space's history retention", async () => {
    const { mom, deviceId, phone } = await home();
    phone.write({ t: "button", index: 7 });
    await phone.nextState("ended");
    expectStatus(
      await s.http("/space/privacy", { method: "PUT", token: mom.token, body: { history: "30d" } }),
      204,
    );
    expect((await activity(mom.token, deviceId)).json.calls).toHaveLength(1);
    s.timers.advance(31 * DAY);
    expect((await activity(mom.token, deviceId)).json.calls).toEqual([]);
  });

  it("marks a missed call that left a voicemail", async () => {
    const { mom, deviceId, phone } = await home();
    const momApp = await s.connectApp(mom.token);
    await offline(phone, momApp);
    momApp.write({ t: "call.dial", deviceId });
    const ended = await momApp.nextState("ended");
    expect(ended.voicemail).toBeDefined();
    const vm = await s.http(
      `/vm/message?ticket=${encodeURIComponent(ended.voicemail?.ticket ?? "")}&durationMs=1000`,
      { method: "POST", raw: new Uint8Array([1, 2, 3]), type: "audio/wav" },
    );
    expectStatus(vm, 201);
    const rows = (await activity(mom.token, deviceId)).json.calls as Row[];
    expect(rows).toMatchObject([{ direction: "in", refused: "offline", voicemail: true }]);
  });
});
