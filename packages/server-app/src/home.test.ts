// Home features on the phones (docs/phone-ux.md "Daily check-in", "Chime", "House intercom"):
// set per phone, off by default; the server watches the check-in time itself.
import { describe, expect, it } from "vitest";
import { expectStatus, NOON_MONDAY, TestServer } from "./testkit.ts";

async function setup() {
  const s = new TestServer({ publicUrl: "https://home.test" });
  const jesse = await s.person("jesse", "Jesse");
  const gran = await s.pairDevice(jesse.token, "Gran");
  if (!gran.deviceId) throw new Error("pairing failed");
  const set = (body: Record<string, unknown>, token = jesse.token, id = gran.deviceId as string) =>
    s.http(`/devices/${id}/home`, { method: "PUT", token, body });
  return { s, jesse, gran: { id: gran.deviceId, key: gran.key }, set };
}

const HOUR = 3_600_000;

describe("the daily check-in", () => {
  it("off by default; asked until I'm OK; the guardians are told once if nobody presses it", async () => {
    const { s, jesse, gran, set } = await setup();
    const phone = await s.connectDevice(gran.id, gran.key.pair, ["missed-calls"]);
    expect(phone.all("config").at(-1)?.checkin).toBeUndefined();
    // 12:00 UTC now: by 13:00.
    expect((await set({ checkinBy: "13:00" })).json).toMatchObject({ checkinBy: "13:00" });
    expect((await phone.next("config")).checkin).toEqual({ by: "13:00", done: false });
    const jApp = await s.connectApp(jesse.token);
    s.timers.advance(HOUR + 2000);
    expect(await jApp.next("voicemail.inbox")).toMatchObject({ from: "Gran" });
    let cfg = await phone.next("config");
    while (!cfg.checkin?.alerted) cfg = await phone.next("config");
    expect(cfg.checkin).toEqual({ by: "13:00", done: false, alerted: true });
    expect((await s.http("/voicemails", { token: jesse.token })).json).toMatchObject([
      { fromLabel: "Gran", transcript: "Gran didn't check in by 13:00." },
    ]);
    // Once a day.
    s.timers.advance(2 * HOUR);
    expect((await s.http("/voicemails", { token: jesse.token })).json).toHaveLength(1);
    // The next morning: I'm OK at 09:00; nothing at 13:00.
    s.timers.advance(18 * HOUR);
    phone.write({ t: "checkin.ok" });
    cfg = await phone.next("config");
    while (!cfg.checkin?.done) cfg = await phone.next("config");
    expect(cfg.checkin).toEqual({ by: "13:00", done: true });
    s.timers.advance(6 * HOUR);
    expect((await s.http("/voicemails", { token: jesse.token })).json).toHaveLength(1);
    expect(s.timers.now).toBeGreaterThan(NOON_MONDAY);
  });

  it("set after today's time passed: nothing asked today; an unplugged phone is still watched", async () => {
    const { s, jesse, set } = await setup();
    // 12:00 now, by 10:00: today counts as done.
    expect((await set({ checkinBy: "10:00" })).status).toBe(200);
    const jApp = await s.connectApp(jesse.token);
    s.timers.advance(HOUR);
    expect((await s.http("/voicemails", { token: jesse.token })).json).toEqual([]);
    // Tomorrow 10:00 passes with the phone never connected: the guardians are told.
    s.timers.advance(22 * HOUR);
    expect(await jApp.next("voicemail.inbox")).toMatchObject({ from: "Gran" });
    // Off again: no more.
    expect((await set({ checkinBy: null })).json).toMatchObject({ checkinBy: null });
    s.timers.advance(24 * HOUR);
    expect(jApp.all("voicemail.inbox")).toHaveLength(1);
  });
});

describe("chime", () => {
  it("the phone posts its words to every phone of the space, at most once a minute", async () => {
    const { s, jesse, gran, set } = await setup();
    const kitchen = await s.pairDevice(jesse.token, "Kitchen");
    if (!kitchen.deviceId) throw new Error("pairing failed");
    const k = await s.connectDevice(kitchen.deviceId, kitchen.key.pair);
    const g = await s.connectDevice(gran.id, gran.key.pair);
    // No chime set: refused.
    k.write({ t: "notice.chime" });
    expect(await k.next("error")).toMatchObject({ message: "this phone has no chime" });
    expect(
      (await set({ chimeText: "Dinner's ready" }, jesse.token, kitchen.deviceId)).json,
    ).toMatchObject({
      chimeText: "DINNER'S READY",
    });
    expect((await k.next("config")).chime).toEqual({ text: "DINNER'S READY" });
    expect(g.all("config").at(-1)?.chime).toBeUndefined();
    k.write({ t: "notice.chime" });
    expect(await g.next("notice")).toMatchObject({ lines: ["DINNER'S READY"], from: "Kitchen" });
    await k.next("notice");
    k.write({ t: "notice.chime" });
    k.write({ t: "ping" });
    await k.next("pong");
    expect(await s.store.notices.live(jesse.household.id, s.timers.now)).toHaveLength(1);
    // Too long for the phones' screens: refused when set.
    expect((await set({ chimeText: "THIS IS FAR TOO LONG FOR A LINE" })).status).toBe(400);
  });
});

describe("house intercom", () => {
  it("on per phone: the space's key and the phone's name in its config; off by default", async () => {
    const { s, jesse, gran, set } = await setup();
    const den = await s.pairDevice(jesse.token, "Den");
    if (!den.deviceId) throw new Error("pairing failed");
    const g = await s.connectDevice(gran.id, gran.key.pair);
    const d = await s.connectDevice(den.deviceId, den.key.pair);
    expect(g.all("config").at(-1)?.intercom).toBeUndefined();
    await set({ intercom: true });
    await set({ intercom: true }, jesse.token, den.deviceId);
    let gc = await g.next("config");
    while (!gc.intercom) gc = await g.next("config");
    let dc = await d.next("config");
    while (!dc.intercom) dc = await d.next("config");
    expect(gc.intercom?.room).toBe("Gran");
    expect(dc.intercom?.room).toBe("Den");
    expect(gc.intercom?.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(dc.intercom?.key).toBe(gc.intercom?.key);
    await set({ intercom: false });
    gc = await g.next("config");
    while (gc.intercom) gc = await g.next("config");
    expect(gc.intercom).toBeUndefined();
  });

  it("only guardians (or the owner of their own phone); not on Lounge phones", async () => {
    const { s, jesse, set } = await setup();
    const bob = await s.store.createUser(
      { householdId: jesse.household.id, name: "Bob", role: "contact" },
      0,
    );
    const bobToken = await s.store.createSession(bob.id, s.timers.now);
    expect((await set({ intercom: true }, bobToken)).status).toBe(404);
    const lounge = await s.pairDevice(jesse.token, "Lobby", { kind: "lounge" });
    expectStatus(await set({ intercom: true }, jesse.token, lounge.deviceId as string), 409);
    const desk = await s.pairDevice(bobToken, "Bob's desk", { forMe: true });
    expectStatus(await set({ chimeText: "LUNCH" }, bobToken, desk.deviceId as string), 200);
  });
});
