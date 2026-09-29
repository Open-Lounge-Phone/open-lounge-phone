// Device modes and lifecycle (docs/device-lifecycle.md): kids / personal / Lounge at claim,
// remove = wipe, the space's Lounge session policy, and what idle Lounge phones offer.
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, type FakeConn, hello, newKey, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

/** Mom (guardian) in "Mom's home", and Dad and Sam (grown-up members, not guardians). */
async function home() {
  const mom = await s.person("mom", "Mom");
  const member = async (name: string) => {
    const user = await s.store.createUser(
      { householdId: mom.household.id, name, role: "contact" },
      s.timers.now,
    );
    return { user, token: await s.store.createSession(user.id, s.timers.now) };
  };
  return { mom, dad: await member("Dad"), sam: await member("Sam") };
}

/** A phone that chose `mode` on its first-run screen, showing its pairing code. */
async function unpaired(mode?: "kids" | "personal" | "lounge") {
  const key = await newKey();
  const conn = s.openDevice();
  conn.write(hello());
  conn.write({ t: "pair.begin", publicKey: key.publicKey, ...(mode ? { kind: mode } : {}) });
  const { code } = await conn.next("pair.code");
  return { key, conn, code };
}

const pair = (token: string, code: string, extra: Record<string, unknown> = {}) =>
  s.http("/devices/pair", { token, body: { code, name: "Phone", ...extra } });

async function signIn(deviceId: string, pair: CryptoKeyPair) {
  const conn = s.openDevice();
  conn.write(hello(deviceId));
  const { nonce } = await conn.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, fromBase64Url(nonce));
  conn.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  return conn;
}

describe("modes at claim", () => {
  it("uses what the phone was set up as, and says so before the claim", async () => {
    const { dad } = await home();
    const phone = await unpaired("personal");
    const preview = await s.http("/devices/pair/preview", {
      token: dad.token,
      body: { code: phone.code },
    });
    expect(preview.json).toMatchObject({ mode: "personal" });
    // A member (not a guardian) claims a phone set up as personal: it becomes theirs.
    const res = await pair(dad.token, phone.code);
    expectStatus(res, 201);
    expect(res.json.mode).toBe("personal");
    const { deviceId } = await phone.conn.next("pair.done");
    const device = await s.store.getDevice(deviceId);
    expect(device).toMatchObject({ ownerUserId: dad.user.id, kind: "kids" });
    const conn = await signIn(deviceId, phone.key.pair);
    expect((await conn.next("config")).owner).toEqual({
      mode: "personal",
      space: "Mom's home",
      person: "Dad",
    });
    const list = await s.http("/devices", { token: dad.token });
    expect(list.json.find((d: { id: string }) => d.id === deviceId)).toMatchObject({
      mode: "personal",
    });
  });

  it("lets only guardians claim kids and Lounge phones; kids' phones only at home", async () => {
    const { mom, dad } = await home();
    for (const mode of ["kids", "lounge"] as const) {
      const phone = await unpaired(mode);
      expectStatus(await pair(dad.token, phone.code), 403);
      expectStatus(await pair(dad.token, phone.code, { mode }), 403);
      // …but a member can take it as their own phone.
      expectStatus(await pair(dad.token, phone.code, { mode: "personal" }), 201);
    }
    const lounge = await unpaired("kids");
    const res = await pair(mom.token, lounge.code, { mode: "lounge" });
    expect(res.json.mode).toBe("lounge");
    const team = await s.person("acme", "Acme", "team");
    const kid = await unpaired("kids");
    expectStatus(await pair(team.token, kid.code), 400);
    expectStatus(await pair(team.token, kid.code, { mode: "lounge" }), 201);
    expectStatus(
      await s.http("/devices/pair/preview", { token: mom.token, body: { code: kid.code } }),
      404,
    );
  });
});

describe("remove = wipe", () => {
  it("tells a connected phone to wipe itself", async () => {
    const { mom } = await home();
    const phone = await unpaired("kids");
    await pair(mom.token, phone.code);
    const { deviceId } = await phone.conn.next("pair.done");
    const conn = await signIn(deviceId, phone.key.pair);
    await conn.next("config");
    expectStatus(await s.http(`/devices/${deviceId}`, { method: "DELETE", token: mom.token }), 204);
    expect(await conn.next("wipe")).toEqual({ t: "wipe", reason: "removed" });
    expect(conn.closed).toMatchObject({ code: 4401 });
  });

  it("tells an offline phone when it comes back and proves it holds the removed key", async () => {
    const { mom } = await home();
    const phone = await unpaired("kids");
    await pair(mom.token, phone.code);
    const { deviceId } = await phone.conn.next("pair.done");
    expectStatus(await s.http(`/devices/${deviceId}`, { method: "DELETE", token: mom.token }), 204);

    // Someone else's key can't make it wipe (nor learn anything).
    const imposter = await newKey();
    const wrong = await signIn(deviceId, imposter.pair);
    await wrong.next("error");
    expect(wrong.all("wipe")).toEqual([]);
    expect(wrong.closed).toMatchObject({ code: 4401 });

    const back = await signIn(deviceId, phone.key.pair);
    expect(await back.next("wipe")).toEqual({ t: "wipe", reason: "removed" });
    expect(back.all("config")).toEqual([]);
    // Once is enough: afterwards it's just an unknown phone.
    const again = s.openDevice();
    again.write(hello(deviceId));
    expect(await again.next("error")).toMatchObject({ code: "unauthorized" });
    expect(again.all("auth.challenge")).toEqual([]);
  });

  it("wipes the phones of a space deleted with its account", async () => {
    const { mom } = await home();
    const phone = await unpaired("kids");
    await pair(mom.token, phone.code);
    const { deviceId } = await phone.conn.next("pair.done");
    const conn = await signIn(deviceId, phone.key.pair);
    await conn.next("config");
    expectStatus(
      await s.http("/account", { method: "DELETE", token: mom.token, body: { confirm: "mom" } }),
      204,
    );
    await conn.next("wipe");
  });
});

describe("Lounge phones: session length and idle options", () => {
  async function loungeSpace() {
    const h = await home();
    const phone = await unpaired("lounge");
    await pair(h.mom.token, phone.code, { name: "Lobby" });
    const { deviceId } = await phone.conn.next("pair.done");
    const conn = await signIn(deviceId, phone.key.pair);
    const config = await conn.next("config");
    const idle = await conn.next("lounge.idle");
    return { ...h, deviceId, conn, idle, config, key: phone.key.pair };
  }

  async function takeOver(app: FakeConn, phone: FakeConn, deviceId: string, nonce: string) {
    app.write({ t: "lounge.claim", deviceId, nonce });
    await app.next("lounge.progress");
    const { index } = await phone.next("lounge.challenge");
    phone.write({ t: "lounge.press", index });
    await phone.next("lounge.session");
  }

  const settings = (token: string, body: unknown) =>
    s.http("/lounge/settings", { method: "PUT", token, body });

  it("is dead while idle by default: no keys, no one here", async () => {
    const { conn, config } = await loungeSpace();
    expect(config).toEqual({
      t: "config",
      buttons: [],
      quiet: false,
      owner: { mode: "lounge", space: "Mom's home" },
    });
    conn.write({ t: "hook", state: "up" });
    conn.write({ t: "button", index: 0 });
    expect(await conn.nextState("ended")).toMatchObject({ reason: "denied" });
  });

  it("is managed by the space's guardians", async () => {
    const { mom, dad } = await loungeSpace();
    expectStatus(await settings(dad.token, { session: "until_logout" }), 403);
    expectStatus(await settings(mom.token, { session: "forever" }), 400);
    expectStatus(await settings(mom.token, { dayEnd: "25:00" }), 400);
    expectStatus(await settings(mom.token, { session: "until_logout" }), 204);
    const listed = await s.http("/lounge", { token: mom.token });
    expect(listed.json).toMatchObject({
      session: "until_logout",
      dayEnd: "00:00",
      idleMinutes: 10,
      idle: { houseLine: { enabled: false, keys: [] }, whosHere: false },
    });
    expect((await s.http("/lounge", { token: dad.token })).json.idle).toBeUndefined();
  });

  it("idle minutes (default), until logout, or the end of the day", async () => {
    const { mom, dad, deviceId, conn, idle } = await loungeSpace();
    const dadApp = await s.connectApp(dad.token);
    await takeOver(dadApp, conn, deviceId, idle.nonce);
    s.timers.advance(10 * 60_000);
    expect(await conn.next("lounge.ended")).toMatchObject({ reason: "idle" });

    expectStatus(await settings(mom.token, { session: "until_logout" }), 204);
    await takeOver(dadApp, conn, deviceId, (await conn.next("lounge.idle")).nonce);
    s.timers.advance(5 * 60 * 60_000);
    expect(conn.all("lounge.ended")).toHaveLength(1);

    // End of day at 18:00 UTC (the space's time zone); it's 17:00 now.
    expectStatus(await settings(mom.token, { session: "end_of_day", dayEnd: "18:00" }), 204);
    s.timers.advance(10 * 60_000);
    expect(conn.all("lounge.ended")).toHaveLength(1);
    s.timers.advance(50 * 60_000);
    await conn.next("lounge.ended");
    expect(conn.all("lounge.ended").at(-1)).toMatchObject({ reason: "idle" });
    // A session started after the day end runs until tomorrow's.
    await takeOver(dadApp, conn, deviceId, (await conn.next("lounge.idle")).nonce);
    s.timers.advance(23 * 60 * 60_000);
    expect(conn.all("lounge.ended")).toHaveLength(2);
    s.timers.advance(60 * 60_000);
    await conn.next("lounge.ended");
    expect(conn.all("lounge.ended")).toHaveLength(3);
  });

  it("house-line keys call as the space, only when the space turns them on", async () => {
    const { mom, dad, sam, conn, deviceId: lobbyId } = await loungeSpace();
    const desk = await unpaired("personal");
    await pair(sam.token, desk.code, { name: "Sam's desk" });
    const { deviceId: deskId } = await desk.conn.next("pair.done");
    const deskConn = await signIn(deskId, desk.key.pair);
    await deskConn.next("config");
    const kid = await unpaired("kids");
    await pair(mom.token, kid.code);
    const { deviceId: kidId } = await kid.conn.next("pair.done");

    const keys = [
      { index: 0, label: "Front desk", target: { kind: "user", userId: dad.user.id } },
      { index: 1, label: "Sam", target: { kind: "device", deviceId: deskId } },
      {
        index: 2,
        label: "Staff",
        target: { kind: "group", userIds: [dad.user.id, sam.user.id] },
      },
    ];
    // Kids' phones and people outside the space are never targets.
    const bad = [{ index: 3, label: "Kid", target: { kind: "device", deviceId: kidId } }];
    expectStatus(await settings(mom.token, { houseLine: { enabled: true, keys: bad } }), 400);
    const outsider = await s.person("eve", "Eve");
    const eve = [{ index: 3, label: "Eve", target: { kind: "user", userId: outsider.user.id } }];
    expectStatus(await settings(mom.token, { houseLine: { enabled: true, keys: eve } }), 400);
    // Configured but not enabled: still nothing.
    expectStatus(await settings(mom.token, { houseLine: { enabled: false, keys } }), 204);
    expect((await conn.next("config")).buttons).toEqual([]);
    conn.write({ t: "button", index: 0 });
    expect(await conn.nextState("ended")).toMatchObject({ reason: "denied" });

    expectStatus(await settings(mom.token, { houseLine: { enabled: true, keys } }), 204);
    const config = await conn.next("config");
    expect(config).toMatchObject({
      houseLine: true,
      buttons: [
        { index: 0, label: "Front desk" },
        { index: 1, label: "Sam" },
        { index: 2, label: "Staff" },
      ],
    });

    // Key 1: Dad, rung as the Lobby.
    const dadApp = await s.connectApp(dad.token);
    const samApp = await s.connectApp(sam.token);
    conn.write({ t: "hook", state: "up" });
    conn.write({ t: "button", index: 0 });
    expect((await dadApp.next("call.ringing")).from.label).toBe("Lobby");
    let out = await conn.nextState("ringing");
    conn.write({ t: "call.hangup", callId: out.callId });
    await conn.nextState("ended");

    // Key 2: Sam's desk phone rings (not Sam's app).
    conn.write({ t: "button", index: 1 });
    expect((await deskConn.next("call.ringing")).from.label).toBe("Lobby");
    out = await conn.nextState("ringing");
    conn.write({ t: "call.hangup", callId: out.callId });
    await conn.nextState("ended");

    // Key 3: the staff group rings everyone; the first to answer takes it.
    const before = {
      dad: dadApp.all("call.ringing").length,
      sam: samApp.all("call.ringing").length,
    };
    conn.write({ t: "button", index: 2 });
    const ring = await samApp.next("call.ringing");
    await dadApp.next("call.ringing");
    expect(dadApp.all("call.ringing").length).toBe(before.dad + 1);
    expect(samApp.all("call.ringing").length).toBe(before.sam + 1);
    samApp.write({ t: "call.answer", callId: ring.callId });
    await samApp.nextState("connecting");
    expect((await dadApp.next("call.state")).state).toBe("ended");
    await conn.nextState("connecting");
    // Sam's log names the Lobby phone: the group call, and the missed one to the desk phone.
    conn.write({ t: "call.hangup", callId: ring.callId });
    await samApp.nextState("ended");
    expect(await s.store.callLog(sam.user.accountId, `device:${lobbyId}`)).toMatchObject([
      { direction: "in", answered: true },
      { direction: "in", answered: false },
    ]);
  });

  it("who's here: idle phones list people open to chat at the space's other Lounge phones", async () => {
    const { mom, dad, conn } = await loungeSpace();
    const other = await unpaired("lounge");
    await pair(mom.token, other.code, { name: "Patio" });
    const { deviceId: patioId } = await other.conn.next("pair.done");
    const patio = await signIn(patioId, other.key.pair);
    const idle = await patio.next("lounge.idle");
    expectStatus(await settings(mom.token, { whosHere: true }), 204);
    expect((await conn.next("config")).here).toEqual([]);
    const dadApp = await s.connectApp(dad.token);
    await takeOver(dadApp, patio, patioId, idle.nonce);
    // Signed in, but not open to chat: not listed.
    expect(conn.all("config").at(-1)?.here).toEqual([]);
    patio.write({ t: "lounge.chat", open: true });
    await patio.next("lounge.session");
    await conn.next("config");
    expect(conn.all("config").at(-1)?.here).toEqual([{ name: "Dad", where: "Patio" }]);
    patio.write({ t: "lounge.leave" });
    await patio.next("lounge.ended");
    expect(conn.all("config").at(-1)?.here).toEqual([]);
  });
});
