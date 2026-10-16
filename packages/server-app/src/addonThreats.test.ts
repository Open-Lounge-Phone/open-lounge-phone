// The add-on threat model (docs/security-model.md, Add-ons), one block per threat. Every add-on
// is treated as untrusted code that holds a valid add-on key: `HostileAddon` sends whatever it
// likes, and these tests check that the server's rules are what stands between it and everyone
// else. Each test names the guard it covers; the important ones were mutation-checked (the guard
// removed, the test seen failing).
import {
  type DeviceToServer,
  DeviceToServer as DeviceToServerSchema,
  fromBase64Url,
  toBase64Url,
} from "@openloungephone/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOK_CLUB,
  connect,
  connectAddon,
  declare,
  dumpDb,
  give,
  HostileAddon,
  type Person,
  settle,
  talk,
} from "./addonHarness.ts";
import { ADDON_MESSAGES, cleanText, TOO_MANY_CALLS_FROM, TOO_MANY_CALLS_TO } from "./addons.ts";
import { fedFetch } from "./federation.ts";
import { ADDON_CALL_LIMIT_NOTE } from "./hub.ts";
import { expectStatus, type FakeConn, Network, type TestServer } from "./testkit.ts";

/** Waits until everything the add-on sent before has been handled (its socket is in order). */
async function sync(addon: HostileAddon): Promise<void> {
  const before = addon.conn.all("pong").length;
  addon.write({ t: "ping" });
  await vi.waitFor(() => expect(addon.conn.all("pong").length).toBe(before + 1));
}

/** A valid example of every message a phone may send, by type (the compiler keeps it complete). */
const SAMPLES: { [K in DeviceToServer["t"]]: Extract<DeviceToServer, { t: K }> } = {
  hello: { t: "hello", proto: 1, model: "addon", fw: "x", buttons: 1, display: "none" },
  "call.extension": { t: "call.extension", number: "200" },
  "call.address": { t: "call.address", address: "jesse@a.test" },
  "call.key": { t: "call.key", callId: "CALL", key: "5" },
  "addon.shares": { t: "addon.shares", shares: [] },
  "addon.share.created": { t: "addon.share.created", requestId: "sr_x", id: "x" },
  "addon.share.refused": { t: "addon.share.refused", requestId: "sr_x", reason: "no" },
  "addon.about": { t: "addon.about", hears: "live" },
  "addon.test.ok": { t: "addon.test.ok", testId: "at_x" },
  "pair.begin": { t: "pair.begin", kind: "addon", publicKey: "A".repeat(43) },
  "auth.proof": { t: "auth.proof", sig: "B".repeat(86) },
  hook: { t: "hook", state: "up" },
  button: { t: "button", index: 0 },
  status: { t: "status", battery: { pct: 5, charging: false } },
  "lounge.press": { t: "lounge.press", index: 0 },
  "lounge.refresh": { t: "lounge.refresh" },
  "lounge.leave": { t: "lounge.leave" },
  "lounge.chat": { t: "lounge.chat", open: true },
  "greeting.begin": { t: "greeting.begin", kind: "custom" },
  "greeting.reset": { t: "greeting.reset" },
  "voicemail.fetch": { t: "voicemail.fetch" },
  "voicemail.heard": { t: "voicemail.heard", id: "vm_x" },
  "missed.clear": { t: "missed.clear" },
  "call.back": { t: "call.back", id: "mc_x" },
  "checkin.ok": { t: "checkin.ok" },
  "checkin.missed": { t: "checkin.missed", by: "09:00" },
  "notice.chime": { t: "notice.chime" },
  "notice.dismiss": { t: "notice.dismiss", id: "nt_x" },
  "call.answer": { t: "call.answer", callId: "CALL" },
  "call.hangup": { t: "call.hangup", callId: "CALL" },
  "call.hold": { t: "call.hold", callId: "CALL", hold: true },
  "call.merge": { t: "call.merge", callId: "CALL", with: "CALL" },
  "call.transfer": { t: "call.transfer", callId: "CALL", to: { extension: "200" } },
  "call.voicemail": { t: "call.voicemail", callId: "CALL" },
  "call.callback": { t: "call.callback", callId: "CALL" },
  "room.leave": { t: "room.leave", roomId: "rm_x" },
  "room.mute": { t: "room.mute", roomId: "rm_x", muted: true },
  "room.lock": { t: "room.lock", roomId: "rm_x", locked: true },
  "room.remove": { t: "room.remove", roomId: "rm_x", participant: "p_x" },
  "room.talk": { t: "room.talk", roomId: "rm_x", speaking: true },
  "room.here": { t: "room.here", roomId: "rm_x" },
  "room.media": { t: "room.media", roomId: "rm_x", type: "offer", sdp: "v=0" },
  "rtc.sdp": { t: "rtc.sdp", callId: "CALL", type: "offer", sdp: "v=0" },
  "rtc.ice": { t: "rtc.ice", callId: "CALL", candidate: null },
  ping: { t: "ping" },
};

const ALL_TYPES = (DeviceToServerSchema.options as { shape: { t: { value: string } } }[]).map(
  (o) => o.shape.t.value,
);

/** One server with add-ons on: Jesse (the owner) and Ana (her connection). */
async function oneServer(limits: Record<string, number> = {}) {
  const net = new Network();
  const a = await net.server("a.test", { env: { addons: true, limits } });
  const jesse = await a.person("jesse", "Jesse");
  const ana = await a.person("ana", "Ana");
  const ids = await connect(a, jesse, a, ana);
  return { net, a, jesse, ana, anaConn: ids.aSide };
}

/** The owner's app calls the add-on, and it answers: an active call. */
async function ownerCall(a: TestServer, owner: Person, evil: HostileAddon) {
  const app = await a.connectApp(owner.token);
  app.write({ t: "call.address", address: evil.address });
  const ring = await evil.conn.next("call.ringing");
  const mine = await app.nextState("ringing");
  await talk(app, evil.conn, mine.callId, ring.callId);
  return { app, appCall: mine.callId, addonCall: ring.callId };
}

describe("1. what an add-on may send", () => {
  it("the allow-list is explicit, and covers only add-on messages", () => {
    expect([...ADDON_MESSAGES].sort()).toEqual(
      [
        "addon.about",
        "addon.share.created",
        "addon.share.refused",
        "addon.shares",
        "addon.test.ok",
        "call.address",
        "call.answer",
        "call.hangup",
        "ping",
        "rtc.ice",
        "rtc.sdp",
      ].sort(),
    );
    // Every message type of the protocol has a sample above (a new type fails here, and the
    // compiler asks for its sample), so the next test sends each one.
    expect(Object.keys(SAMPLES).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("every other message is refused with no effect, even during a live call", async () => {
    const { a, jesse } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    const phone = await a.pairDevice(jesse.token, "Desk", { forMe: true });
    const desk = await a.connectDevice(phone.deviceId as string, phone.key?.pair as CryptoKeyPair);
    const kid = await a.pairDevice(jesse.token, "Kid");
    const kidPhone = await a.connectDevice(kid.deviceId as string, kid.key?.pair as CryptoKeyPair);
    const call = await ownerCall(a, jesse, evil);
    await settle(a);
    const others: FakeConn[] = [call.app, desk, kidPhone];
    for (const t of ALL_TYPES as DeviceToServer["t"][]) {
      if (ADDON_MESSAGES.has(t)) continue;
      const sample = JSON.parse(
        JSON.stringify(SAMPLES[t]).replaceAll('"CALL"', JSON.stringify(call.addonCall)),
      );
      const db = await dumpDb(a);
      const heard = others.map((c) => c.sent.length);
      const errors = evil.errors().length;
      const ref = `m_${t.replaceAll(".", "_")}`;
      evil.send({ ...sample, id: ref });
      await sync(evil);
      await settle(a);
      expect(evil.errors().slice(errors), t).toEqual([
        { t: "error", code: "bad_message", message: `not for add-ons: ${t}`, ref },
      ]);
      expect(await dumpDb(a), t).toEqual(db);
      expect(
        others.map((c) => c.sent.length),
        t,
      ).toEqual(heard);
    }
    // The call it's on went on untouched; the socket is still open.
    expect(call.app.all("call.state").at(-1)?.state).toBe("active");
    expect(evil.conn.closed).toBeUndefined();
  }, 30_000);

  it("a type the protocol doesn't know, malformed JSON or an oversized frame: an error, nothing more", async () => {
    const { a, jesse } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    const db = await dumpDb(a);
    evil.send({ t: "addon.grant", share: "bookclub", to: "ana@a.test" });
    evil.raw("{nope");
    evil.raw(
      JSON.stringify({ t: "addon.shares", shares: [{ id: "x", label: "y".repeat(20_000) }] }),
    );
    evil.send({ t: "call.address", address: 7 });
    await sync(evil);
    expect(evil.errors().map((e) => e.message)).toEqual([
      "not supported: addon.grant",
      expect.stringMatching(/JSON|Unexpected|Expected/),
      expect.stringMatching(/exceeds 16384 bytes/),
      expect.stringMatching(/^address:/),
    ]);
    expect(await dumpDb(a)).toEqual(db);
    expect(evil.conn.closed).toBeUndefined();
  });

  it("before it signs in, it can only finish the handshake", async () => {
    const { a, jesse } = await oneServer();
    const linked = await HostileAddon.link(a, jesse);
    const app = await a.connectApp(jesse.token);
    const conn = a.openDevice();
    conn.write({ ...SAMPLES.hello, deviceId: linked.id });
    await conn.next("auth.challenge");
    conn.write({ t: "call.address", address: "jesse@a.test" });
    await vi.waitFor(() => expect(conn.closed).toBeDefined());
    expect(conn.all("call.state")).toEqual([]);
    expect(app.all("call.ringing")).toEqual([]);
    // A wrong signature doesn't get it in either.
    const again = a.openDevice();
    again.write({ ...SAMPLES.hello, deviceId: linked.id });
    await again.next("auth.challenge");
    again.write({ t: "auth.proof", sig: "B".repeat(86) });
    expect((await again.next("error")).message).toBe("bad signature");
    expect(again.all("config")).toEqual([]);
  });

  it("call messages for calls it isn't part of do nothing", async () => {
    const { a, jesse, ana } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    // Jesse and Ana talk; the add-on knows (or guesses) their call id.
    const jesseApp = await a.connectApp(jesse.token);
    const anaApp = await a.connectApp(ana.token);
    jesseApp.write({ t: "call.address", address: "nobody+x@a.test" });
    await jesseApp.nextState("ended");
    const conns = (await a.http("/connections", { token: jesse.token })).json.connections;
    jesseApp.write({ t: "call.connection", connectionId: conns[0].id });
    const ring = await anaApp.next("call.ringing");
    const mine = await jesseApp.nextState("ringing");
    await talk(jesseApp, anaApp, mine.callId, ring.callId);
    const heard = [jesseApp.sent.length, anaApp.sent.length];
    for (const callId of [mine.callId, ring.callId]) {
      evil.write({ t: "call.answer", callId });
      evil.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 evil" });
      evil.write({ t: "rtc.ice", callId, candidate: "candidate:1 1 udp 1 6.6.6.6 6 typ host" });
      evil.write({ t: "call.hangup", callId });
    }
    await sync(evil);
    expect([jesseApp.sent.length, anaApp.sent.length]).toEqual(heard);
    expect(jesseApp.all("call.state").at(-1)?.state).toBe("active");
    // Nor does answering its own call out (only the callee answers).
    evil.write({ t: "call.address", address: "jesse@a.test" });
    const out = await evil.conn.nextState("ringing");
    evil.write({ t: "call.answer", callId: out.callId });
    await sync(evil);
    expect(evil.conn.all("rtc.config")).toEqual([]);
  });

  it("a flood of messages closes its socket and ends its calls", async () => {
    const { a, jesse } = await oneServer({ addonMessagesPerMinute: 30 });
    const evil = await HostileAddon.link(a, jesse);
    const call = await ownerCall(a, jesse, evil);
    for (let i = 0; i < 40; i++) evil.write({ t: "ping" });
    await vi.waitFor(() => expect(evil.conn.closed?.code).toBe(4429));
    expect(evil.errors().at(-1)).toMatchObject({ code: "rate_limited" });
    expect(await call.app.nextState("ended")).toBeTruthy();
  });
});

describe("2. who it can reach", () => {
  it("an add-on call to someone here needs a share they hold, even from this server", async () => {
    const { a, jesse, ana } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
    const anaApp = await a.connectApp(ana.token);
    const from = { handle: "jesse", id: jesse.account.id, name: "Jesse" };
    const to = { kind: "person" as const, handle: "ana" };
    for (const extra of [{}, { addonShare: BOOK_CLUB }]) {
      const r = await a.env.calls?.receive("", {
        callId: "call_l1",
        from,
        to,
        addon: "evil",
        ...extra,
      });
      expect(r).toEqual({ state: "ended", reason: "unavailable" });
    }
    expect(anaApp.all("call.ringing")).toEqual([]);
  });

  it("only its owner and holders: never another add-on, a line, a stranger or a guess", async () => {
    const { a, jesse, ana } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    const other = await HostileAddon.link(a, ana, "notes");
    const eve = await a.person("eve", "Eve");
    const eveApp = await a.connectApp(eve.token);
    for (const address of [
      "ana+notes@a.test", // another add-on
      "ana+notes+bookclub@a.test",
      "eve@a.test", // a stranger
      "ana@a.test", // a connection of its owner, no share
      "support@a.test", // a public line's style of address
      "jesse+evil@a.test", // itself
      "x@b.test",
    ]) {
      evil.write({ t: "call.address", address });
      expect(await evil.conn.nextState("ended"), address).toMatchObject({ reason: "unavailable" });
    }
    // Naming a share it doesn't offer, or another add-on's share, changes nothing.
    await declare(a, other, [BOOK_CLUB]);
    evil.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(eveApp.all("call.ringing")).toEqual([]);
    expect(other.conn.all("call.ringing")).toEqual([]);
  });

  it("nothing can point at it but an address: no extension, ring group, key or phone page", async () => {
    const net = new Network();
    const a = await net.server("a.test", { env: { addons: true } });
    const boss = await a.person("boss", "Boss", "team");
    const evil = await HostileAddon.link(a, boss);
    const ext = await a.http("/extensions/200", {
      method: "PUT",
      token: boss.token,
      body: { kind: "device", targetId: evil.id },
    });
    expect(ext.status).toBe(400);
    const grp = await a.http("/groups", {
      token: boss.token,
      body: { name: "Sales", extension: "300", members: [evil.id] },
    });
    expect(grp.status).toBe(400);
    const phone = await a.pairDevice(boss.token, "Desk", { forMe: true });
    const key = await a.http(`/devices/${phone.deviceId}/buttons/1`, {
      method: "PUT",
      token: boss.token,
      body: { userId: evil.id },
    });
    expect(key.status).toBe(400);
    // It isn't a phone: no phone page acts on it.
    for (const [method, path] of [
      ["PATCH", `/devices/${evil.id}`],
      ["DELETE", `/devices/${evil.id}`],
      ["PUT", `/devices/${evil.id}/lines`],
      ["PUT", `/devices/${evil.id}/buttons/1`],
    ] as const) {
      const res = await a.api.request(path, {
        method,
        headers: { authorization: `Bearer ${boss.token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "x", address: "boss+evil@a.test", label: "x", userId: null }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // An app can't dial it as a phone or a person either.
    const app = await a.connectApp(boss.token);
    app.write({ t: "call.dial", deviceId: evil.id });
    app.write({ t: "call.user", userId: evil.id });
    await new Promise((r) => setTimeout(r, 20));
    expect(evil.conn.all("call.ringing")).toEqual([]);
  });

  it("someone else's share ids, grant ids and requests get nowhere", async () => {
    const { a, jesse, ana, anaConn } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    const notes = await HostileAddon.link(a, jesse, "notes");
    await declare(a, evil, [BOOK_CLUB]);
    await declare(a, notes, [BOOK_CLUB]);
    const g = await give(a, jesse, evil.id, "bookclub", `conn:${anaConn}`);
    // Ana holds evil's book club, not notes' (same share id on another add-on).
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+notes+bookclub@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // notes can't call her within a share of the same id.
    notes.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    expect(await notes.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // A grant id of one add-on means nothing on another, or to anyone but its owner.
    const del = (addon: string, token: string) =>
      a.http(`/addons/${addon}/grants/${g.json.grantId}`, { method: "DELETE", token });
    expect((await del(notes.id, jesse.token)).status).toBe(404);
    expect((await del(evil.id, ana.token)).status).toBe(404);
    // Another add-on's share request can't be answered by this one.
    const req = await a.http(`/addons/${notes.id}/share-requests`, {
      token: jesse.token,
      body: { label: "Garden", with: [] },
    });
    const sent = await notes.conn.next("addon.share.request");
    evil.write({ t: "addon.shares", shares: [BOOK_CLUB, { id: "garden", label: "Garden" }] });
    evil.write({ t: "addon.share.created", requestId: sent.requestId, id: "garden" });
    await sync(evil);
    await settle(a);
    expect(evil.errors().at(-1)?.message).toBe("no such request");
    const r = await a.http(`/addons/${notes.id}/share-requests/${req.json.id}`, {
      token: jesse.token,
    });
    expect(r.json.state).toBe("waiting");
  });

  it("removing it, its owner leaving the space, or being suspended stops it at once, live calls too", async () => {
    // Removed (a live call ends).
    {
      const { a, jesse } = await oneServer();
      const evil = await HostileAddon.link(a, jesse);
      const call = await ownerCall(a, jesse, evil);
      await a.http(`/addons/${evil.id}`, { method: "DELETE", token: jesse.token });
      expect(await call.app.nextState("ended")).toBeTruthy();
      expect(evil.conn.all("wipe")).toHaveLength(1);
    }
    // Its owner leaves the space it was linked in (a team): told to forget, its call ends,
    // and the people holding its shares lose them.
    {
      const net = new Network();
      const a = await net.server("a.test", { env: { addons: true } });
      const boss = await a.person("boss", "Boss", "team");
      const jesse = await a.person("jesse", "Jesse");
      const ana = await a.person("ana", "Ana");
      const anaConn = (await connect(a, jesse, a, ana)).aSide;
      const member = await a.store.createUser(
        {
          householdId: boss.household.id,
          name: "Jesse",
          role: "contact",
          accountId: jesse.account.id,
        },
        net.timers.now,
      );
      const token = await a.store.createAccountSession(jesse.account.id, member.id, net.timers.now);
      const evil = await HostileAddon.link(a, {
        ...jesse,
        token,
        user: member,
        household: boss.household,
      });
      await declare(a, evil, [BOOK_CLUB]);
      expectStatus(await give(a, { ...jesse, token }, evil.id, "bookclub", `conn:${anaConn}`), 201);
      const anaApp = await a.connectApp(ana.token);
      anaApp.write({ t: "call.address", address: "jesse+evil+bookclub@a.test" });
      const ring = await evil.conn.next("call.ringing");
      const mine = await anaApp.nextState("ringing");
      await talk(anaApp, evil.conn, mine.callId, ring.callId);
      expectStatus(await a.http("/space/leave", { method: "POST", token }), 200);
      expect(await anaApp.nextState("ended")).toBeTruthy();
      expect(evil.conn.all("wipe")).toHaveLength(1);
      expect(evil.conn.closed).toBeDefined();
      expect((await a.http("/addons/shared", { token: ana.token })).json.held).toMatchObject([
        { addon: "evil", stopped: "removed" },
      ]);
      // It comes back with its key: told to forget again, nothing more.
      const back = a.openDevice();
      back.write({ ...SAMPLES.hello, deviceId: evil.id });
      await back.next("auth.challenge");
    }
    // Its owner is suspended: cut off with its calls, can't connect, can't be called.
    {
      const { a, jesse, ana } = await oneServer();
      const boss = await a.person("boss", "Boss");
      a.env.operators = [boss.account.id];
      const evil = await HostileAddon.link(a, jesse);
      const call = await ownerCall(a, jesse, evil);
      expectStatus(
        await a.http(`/admin/accounts/${jesse.account.id}/suspend`, {
          token: boss.token,
          body: { suspended: true },
        }),
        204,
      );
      expect(await call.app.nextState("ended")).toBeTruthy();
      expect(evil.conn.closed?.code).toBe(4401);
      expect(evil.conn.all("wipe")).toEqual([]); // not removed: it may come back later
      const back = a.openDevice();
      back.write({ ...SAMPLES.hello, deviceId: evil.id });
      const { nonce } = await back.next("auth.challenge");
      const sig = await crypto.subtle.sign(
        "Ed25519",
        evil.key.pair.privateKey,
        fromBase64Url(nonce),
      );
      back.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
      expect((await back.next("error")).message).toMatch(/can't use it now/);
      expect(back.all("config")).toEqual([]);
      const anaApp = await a.connectApp(ana.token);
      anaApp.write({ t: "call.address", address: evil.address });
      expect(await anaApp.nextState("ended")).toMatchObject({ reason: "unavailable" });
    }
  });
});

describe("3. abuse by volume", () => {
  it("it places one call at a time, a few an hour, and rings one person only so often", async () => {
    const { a, jesse, ana, anaConn } = await oneServer({
      addonCallsOutPerHour: 3,
      addonCallsOutPerPersonPerDay: 2,
    });
    const evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
    await give(a, jesse, evil.id, "bookclub", `conn:${anaConn}`);
    const cy = await a.person("cy", "Cy");
    const cyConn = (await connect(a, jesse, a, cy)).aSide;
    await give(a, jesse, evil.id, "bookclub", `conn:${cyConn}`);
    const anaApp = await a.connectApp(ana.token);
    const cyApp = await a.connectApp(cy.token);
    const ring = async (address: string) => {
      evil.write({ t: "call.address", address, share: "bookclub" });
      const s = await evil.conn.next("call.state");
      if (s.state === "ringing") {
        evil.write({ t: "call.hangup", callId: s.callId });
        await evil.conn.nextState("ended");
      }
      return s;
    };
    // While one call rings, it can't place another (no ringing everyone at once).
    evil.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    const first = await evil.conn.nextState("ringing");
    evil.write({ t: "call.address", address: "cy@a.test", share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "busy" });
    expect(cyApp.all("call.ringing")).toEqual([]);
    evil.write({ t: "call.hangup", callId: first.callId });
    await evil.conn.nextState("ended");
    // Ana: once more today, then no more (the busy attempt didn't count against her).
    expect(await ring("ana@a.test")).toMatchObject({ state: "ringing" });
    expect(await ring("ana@a.test")).toMatchObject({ state: "ended", note: TOO_MANY_CALLS_FROM });
    // Cy still can be called, until the hourly limit.
    expect(await ring("cy@a.test")).toMatchObject({ state: "ended", note: TOO_MANY_CALLS_FROM });
    expect(anaApp.all("call.ringing")).toHaveLength(2);
    // The next hour: the hourly limit lapsed; Ana's daily one still holds.
    a.timers.advance(61 * 60_000);
    expect(await ring("cy@a.test")).toMatchObject({ state: "ringing" });
    expect(await ring("ana@a.test")).toMatchObject({ note: TOO_MANY_CALLS_FROM });
    // Its owner sees it once per limit in the audit trail (no content).
    const trail = (await a.http("/space/audit", { token: jesse.token })).json as {
      action: string;
      detail: { what: string };
    }[];
    expect(
      trail
        .filter((e) => e.action === "addon.limit")
        .map((e) => e.detail.what)
        .sort(),
    ).toEqual(["calls per hour", "calls to one person per day"]);
  });

  it("one person can call it only so often", async () => {
    const { a, jesse } = await oneServer({ addonCallsInPerCallerPerHour: 2 });
    const evil = await HostileAddon.link(a, jesse);
    const app = await a.connectApp(jesse.token);
    for (let i = 0; i < 2; i++) {
      app.write({ t: "call.address", address: evil.address });
      const r = await app.nextState("ringing");
      app.write({ t: "call.hangup", callId: r.callId });
      await app.nextState("ended");
    }
    app.write({ t: "call.address", address: evil.address });
    expect(await app.nextState("ended")).toMatchObject({
      reason: "denied",
      note: TOO_MANY_CALLS_TO,
    });
  });

  it("share-list churn and reconnect storms are cut off", async () => {
    const { a, jesse } = await oneServer({ addonShareUpdatesPerHour: 3, addonConnectsPerHour: 3 });
    const evil = await HostileAddon.link(a, jesse);
    for (let i = 0; i < 3; i++) await declare(a, evil, [{ id: `s${i}`, label: `S ${i}` }]);
    evil.write({ t: "addon.shares", shares: [{ id: "late", label: "Late" }] });
    await sync(evil);
    expect(evil.errors().at(-1)).toMatchObject({ code: "rate_limited" });
    expect(await a.store.addons.shares(evil.id)).toEqual([{ id: "s2", label: "S 2" }]);
    // It connected once when linked; two more, then it's refused (another add-on isn't).
    await evil.reconnect();
    await evil.reconnect();
    const storm = a.openDevice();
    storm.write({ ...SAMPLES.hello, deviceId: evil.id });
    const { nonce } = await storm.next("auth.challenge");
    const sig = await crypto.subtle.sign("Ed25519", evil.key.pair.privateKey, fromBase64Url(nonce));
    storm.write({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    expect(await storm.next("error")).toMatchObject({ code: "rate_limited" });
    expect(storm.closed?.code).toBe(4429);
    expect(storm.all("config")).toEqual([]);
    const fine = await HostileAddon.link(a, jesse, "fine");
    expect(fine.conn.closed).toBeUndefined();
  });

  it("one call at a time unless it says otherwise", async () => {
    const { a, jesse, ana, anaConn } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
    await give(a, jesse, evil.id, "bookclub", `conn:${anaConn}`);
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: evil.address });
    await evil.conn.next("call.ringing");
    const anaApp = await a.connectApp(ana.token);
    anaApp.write({ t: "call.address", address: "jesse+evil+bookclub@a.test" });
    expect(await anaApp.nextState("ended")).toMatchObject({ reason: "busy" });
  });
});

/** A one-way "radio": says it only plays sound, takes `lines` calls at once. */
async function radio(a: TestServer, owner: Person, lines: number) {
  const r = await HostileAddon.link(a, owner, "radio");
  r.write({ t: "addon.about", hears: "nothing", answers: true, shares: true, lines });
  await sync(r);
  await declare(a, r, [{ id: "listen", label: "Listen" }]);
  return r;
}

describe("4. long and one-way calls", () => {
  it("a radio takes several listeners at once, up to the server's limit; the owner pays", async () => {
    const { a, net, jesse } = await oneServer({ addonCallsAtOnce: 3 });
    a.env.fairUse = { callMinutesPerMonth: 1000 };
    const station = await radio(a, jesse, 50);
    const listeners = [];
    for (const name of ["ana2", "bo", "cy", "di"]) {
      const p = await a.person(name, name);
      const conn = (await connect(a, jesse, a, p)).aSide;
      expectStatus(await give(a, jesse, station.id, "listen", `conn:${conn}`), 201);
      listeners.push({ p, app: await a.connectApp(p.token) });
    }
    const live: string[] = [];
    for (const l of listeners.slice(0, 3)) {
      l.app.write({ t: "call.address", address: "jesse+radio+listen@a.test" });
      const ring = await station.conn.next("call.ringing");
      const mine = await l.app.nextState("ringing");
      // It answers each one; the others stay live (no hold, as a person's call waiting would).
      await talk(l.app, station.conn, mine.callId, ring.callId);
      live.push(ring.callId);
    }
    for (const l of listeners.slice(0, 3)) {
      expect(l.app.all("call.state").at(-1)?.state).toBe("active");
      expect(l.app.all("call.state").filter((m) => m.hold)).toEqual([]);
    }
    // The fourth: busy (its 50 is capped at the server's 3).
    listeners[3]?.app.write({ t: "call.address", address: "jesse+radio+listen@a.test" });
    expect(await listeners[3]?.app.nextState("ended")).toMatchObject({ reason: "busy" });
    // Two minutes of sound, then everyone hangs up: 3 × 2 minutes on its owner.
    net.timers.advance(2 * 60_000);
    for (const id of live) station.write({ t: "call.hangup", callId: id });
    await sync(station);
    await settle(a);
    expect((await a.store.usage(jesse.account.id, net.timers.now)).callMinutes).toBe(6);
    for (const { p } of listeners) {
      expect((await a.store.usage(p.account.id, net.timers.now)).callMinutes).toBe(0);
    }
  });

  it("a call with an add-on ends at its longest; TURN credentials last no longer and are revoked", async () => {
    const { a, net, jesse } = await oneServer({ addonCallMinutes: 30 });
    const ttls: (number | undefined)[] = [];
    const revoked: string[] = [];
    let n = 0;
    a.env.iceServers = async (opts) => {
      ttls.push(opts?.ttlSeconds);
      n += 1;
      return [{ urls: "turn:turn.example:3478", username: `u${n}`, credential: "c" }];
    };
    a.env.revokeIce = async (users) => void revoked.push(...users);
    const evil = await HostileAddon.link(a, jesse);
    // Ringing and refused calls get no credentials at all.
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: evil.address });
    const ring = await evil.conn.next("call.ringing");
    await app.nextState("ringing");
    expect(evil.conn.all("rtc.config")).toEqual([]);
    evil.write({ t: "call.hangup", callId: ring.callId });
    await app.nextState("ended");
    expect(ttls).toEqual([]);
    // Answered: credentials for at most the longest call.
    const call = await ownerCall(a, jesse, evil);
    expect(ttls).toEqual([30 * 60 + 120]);
    expect(evil.conn.all("rtc.config").at(-1)?.iceServers[0]).toMatchObject({ username: "u1" });
    net.timers.advance(29 * 60_000);
    await a.gateway.hub(jesse.household.id).wake();
    expect(call.app.all("call.state").at(-1)?.state).toBe("active");
    // The hub's own alarm ends it at 30 minutes.
    net.timers.advance(60_000);
    expect(await call.app.nextState("ended")).toMatchObject({ note: ADDON_CALL_LIMIT_NOTE });
    await settle(a);
    expect(revoked).toEqual(["u1"]);
    expect((await a.store.usage(jesse.account.id, net.timers.now)).callMinutes).toBe(30);
    // A call between people keeps the host's own credentials (no add-on rule).
    ttls.length = 0;
    const ana = await a.person("ana3", "Ana");
    await connect(a, jesse, a, ana);
    const conns = (await a.http("/connections", { token: jesse.token })).json.connections;
    const anaApp = await a.connectApp(ana.token);
    app.write({ t: "call.connection", connectionId: conns.at(-1).id });
    const r2 = await anaApp.next("call.ringing");
    const m2 = await app.nextState("ringing");
    await talk(app, anaApp, m2.callId, r2.callId);
    // (each household's hub hands its own side credentials)
    expect(ttls.length).toBeGreaterThan(0);
    expect(ttls.every((t) => t === undefined)).toBe(true);
    app.write({ t: "call.hangup", callId: m2.callId });
    await anaApp.nextState("ended");
    await settle(a);
    expect(revoked).toEqual(["u1"]);
  });

  it("what it says it does is enforced: no calls in, no calls out, no shares, no keys", async () => {
    const { a, jesse, anaConn } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
    await give(a, jesse, evil.id, "bookclub", `conn:${anaConn}`);
    evil.write({ t: "addon.about", hears: "live", answers: false, calls: false });
    await sync(evil);
    // shares: false (the default) took its shares, with their grants.
    expect(await a.store.addons.shares(evil.id)).toEqual([]);
    expect(await a.store.addons.grants(evil.id)).toEqual([]);
    evil.write({ t: "addon.shares", shares: [BOOK_CLUB] });
    await sync(evil);
    expect(evil.errors().at(-1)?.message).toMatch(/no shares/);
    const app = await a.connectApp(jesse.token);
    app.write({ t: "call.address", address: evil.address });
    expect(await app.nextState("ended")).toMatchObject({ reason: "unavailable" });
    evil.write({ t: "call.address", address: "jesse@a.test" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // It takes calls, not keys.
    evil.write({ t: "addon.about", hears: "live", keys: false });
    await sync(evil);
    const call = await ownerCall(a, jesse, evil);
    call.app.write({ t: "call.key", callId: call.appCall, key: "1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(evil.conn.all("call.key")).toEqual([]);
    // The owner's page shows what it said and what it may do.
    const page = (await a.http("/addons", { token: jesse.token })).json.addons[0];
    expect(page).toMatchObject({
      about: { hears: "live", keys: false, answers: true, calls: false, shares: false, lines: 1 },
      rules: { answers: true, calls: false, shares: false, keys: false, lines: 1 },
    });
  });
});

describe("5. it can't pass for someone else", () => {
  it("labels and words it chooses are plain text: no control or direction characters", async () => {
    for (const bad of ["Mom\nPOLICE", "‮ECILOP", "Bank​", "\u0007ring", "...", "   "]) {
      expect(cleanText(bad, 40), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanText("Book   club", 40)).toBe("Book club");
    const { a, jesse } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    evil.write({ t: "addon.shares", shares: [{ id: "x", label: "Mom‮" }] });
    evil.write({ t: "addon.about", hears: "live", summary: "Hi\u0000there" });
    await sync(evil);
    expect(evil.errors().map((e) => e.message)).toEqual([
      "share x: use plain words for its label",
      expect.stringMatching(/summary/),
    ]);
    expect(await a.store.addons.shares(evil.id)).toEqual([]);
    // Its hello's "fw" is shown on its page: cleaned the same way.
    const back = a.openDevice();
    back.write({ ...SAMPLES.hello, fw: "CALL‮FAILED", deviceId: evil.id });
    await back.next("auth.challenge");
    expect((await a.store.addons.get(evil.id))?.fw).toBe("olp-addon/test");
  });

  it("whatever its name, a call from it is always marked as an add-on's", async () => {
    const { a, jesse, ana, anaConn } = await oneServer();
    const police = await HostileAddon.link(a, jesse, "police");
    await declare(a, police, [{ id: "mom", label: "Mom" }]);
    await give(a, jesse, police.id, "mom", `conn:${anaConn}`);
    const anaApp = await a.connectApp(ana.token);
    police.write({ t: "call.address", address: "ana@a.test", share: "mom" });
    expect((await anaApp.next("call.ringing")).from).toEqual({
      label: "police",
      address: "jesse+police+mom@a.test",
      kind: "addon",
      share: "Mom",
    });
  });
});

describe("6. a holder can stop it calling them", () => {
  it("Stop its calls: refused by the holder's own server; they can still call it; Leave gives it back", async () => {
    const { a, jesse, ana, anaConn } = await oneServer();
    const evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
    await give(a, jesse, evil.id, "bookclub", `conn:${anaConn}`);
    const anaApp = await a.connectApp(ana.token);
    expectStatus(
      await a.http("/addons/muted", {
        method: "PUT",
        token: ana.token,
        body: { address: "jesse+evil@a.test", muted: true },
      }),
      204,
    );
    expect((await a.http("/addons/shared", { token: ana.token })).json.held[0].muted).toBe(true);
    evil.write({ t: "call.address", address: "ana@a.test", share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(anaApp.all("call.ringing")).toEqual([]);
    anaApp.write({ t: "call.address", address: "jesse+evil+bookclub@a.test" });
    const ring = await evil.conn.next("call.ringing");
    evil.write({ t: "call.hangup", callId: ring.callId });
    await anaApp.nextState("ended");
    await evil.conn.nextState("ended");
    // Its owner can't mute it for her (or anything that isn't held).
    expect(
      (
        await a.http("/addons/muted", {
          method: "PUT",
          token: jesse.token,
          body: { address: "jesse+evil@a.test", muted: true },
        })
      ).status,
    ).toBe(404);
    // Someone in the add-on's own space (rung there directly) is spared the same way.
    const cy = await a.store.createUser(
      { householdId: jesse.household.id, name: "Cy", role: "contact" },
      a.timers.now,
    );
    expectStatus(await give(a, jesse, evil.id, "bookclub", `user:${cy.id}`), 201);
    const cyToken = await a.store.createSession(cy.id, a.timers.now);
    const cyApp = await a.connectApp(cyToken);
    const cyAddress = `${(await a.store.getAccount(cy.accountId))?.handle}@a.test`;
    await a.http("/addons/muted", {
      method: "PUT",
      token: cyToken,
      body: { address: "jesse+evil@a.test", muted: true },
    });
    evil.write({ t: "call.address", address: cyAddress, share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    expect(cyApp.all("call.ringing")).toEqual([]);
    // Leave, during a call: it ends, the grant goes, the owner sees it (audited).
    anaApp.write({ t: "call.address", address: "jesse+evil+bookclub@a.test" });
    const r2 = await evil.conn.next("call.ringing");
    const m2 = await anaApp.nextState("ringing");
    await talk(anaApp, evil.conn, m2.callId, r2.callId);
    expectStatus(
      await a.http("/addons/leave", {
        token: ana.token,
        body: { address: "jesse+evil+bookclub@a.test" },
      }),
      204,
    );
    expect(await anaApp.nextState("ended")).toBeTruthy();
    expect((await a.store.addons.grants(evil.id)).map((g) => g.name)).toEqual(["Cy"]);
    const trail = (await a.http("/space/audit", { token: jesse.token })).json as {
      action: string;
    }[];
    expect(trail.map((e) => e.action)).toContain("addon.leave");
    // Leaving what you don't hold: not found.
    expect(
      (
        await a.http("/addons/leave", {
          token: ana.token,
          body: { address: "jesse+evil+bookclub@a.test" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("7. across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  let ids: { aSide: string; bSide: string };
  let evil: HostileAddon;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", { env: { addons: true } });
    b = await net.server("b.test", { env: { addons: true } });
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
    ids = await connect(a, jesse, b, bob);
    evil = await HostileAddon.link(a, jesse);
    await declare(a, evil, [BOOK_CLUB]);
  });

  const party = () => ({ handle: "jesse", id: jesse.account.id, name: "Jesse" });

  it("a server can't have an add-on call someone there who holds nothing (their server checks)", async () => {
    // a.test acts in bad faith: it places add-on calls to Bob though it never gave him a share.
    const bobApp = await b.connectApp(bob.token);
    for (const extra of [{}, { addonShare: { id: "bookclub", label: "POLICE" } }]) {
      const res = await fedFetch(a.env, "b.test", "/calls", {
        json: {
          callId: `call_x${Object.keys(extra).length}`,
          from: party(),
          to: { kind: "person", handle: "bob" },
          addon: "evil",
          ...extra,
        },
      });
      expect(await res.json()).toEqual({ state: "ended", reason: "unavailable" });
    }
    expect(bobApp.all("call.ringing")).toEqual([]);
    // Given the share (a.test told b.test), a call within it rings, with the label b.test was
    // told, not one made up for the call.
    expectStatus(await give(a, jesse, evil.id, "bookclub", `conn:${ids.aSide}`), 201);
    await vi.waitFor(async () => expect(await b.store.addons.received(ids.bSide)).toHaveLength(1));
    // Even then, never through a guest at one of its Lounge phones, or with a made-up ringing label.
    for (const extra of [{ guestOf: "c.test" }, { ringLabel: "POLICE" }]) {
      const res = await fedFetch(a.env, "b.test", "/calls", {
        json: {
          callId: `call_g${Object.keys(extra)[0]}`,
          from: party(),
          to: { kind: "person", handle: "bob" },
          addon: "evil",
          addonShare: { id: "bookclub", label: "Book club" },
          ...extra,
        },
      });
      expect(await res.json()).toEqual({ state: "ended", reason: "unavailable" });
    }
    expect(bobApp.all("call.ringing")).toEqual([]);
    const res = await fedFetch(a.env, "b.test", "/calls", {
      json: {
        callId: "call_x9",
        from: party(),
        to: { kind: "person", handle: "bob" },
        addon: "evil",
        addonShare: { id: "bookclub", label: "POLICE" },
      },
    });
    expect(await res.json()).toEqual({ state: "ringing" });
    expect((await bobApp.next("call.ringing")).from).toMatchObject({
      kind: "addon",
      share: "Book club",
    });
  });

  it("Bob stops its calls on his own server, and gives the share back from there", async () => {
    expectStatus(await give(a, jesse, evil.id, "bookclub", `conn:${ids.aSide}`), 201);
    await vi.waitFor(async () => expect(await b.store.addons.received(ids.bSide)).toHaveLength(1));
    expectStatus(
      await b.http("/addons/muted", {
        method: "PUT",
        token: bob.token,
        body: { address: "jesse+evil@a.test", muted: true },
      }),
      204,
    );
    evil.write({ t: "call.address", address: "bob@b.test", share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
    // He leaves it: a.test drops his grant (feature addon-leave), b.test forgets it.
    expectStatus(
      await b.http("/addons/leave", {
        token: bob.token,
        body: { address: "jesse+evil+bookclub@a.test" },
      }),
      204,
    );
    expect(await b.store.addons.received(ids.bSide)).toEqual([]);
    expect(await a.store.addons.grants(evil.id)).toEqual([]);
  });

  it("a leave from another server only takes that server's own person's grant", async () => {
    expectStatus(await give(a, jesse, evil.id, "bookclub", `conn:${ids.aSide}`), 201);
    const c = await net.server("c.test", { env: { addons: true } });
    // c.test claims to be giving back Bob's share: it can only speak for its own people.
    await fedFetch(c.env, "a.test", "/addon-shares/leave", {
      json: {
        from: { handle: "bob", id: bob.account.id, name: "Bob" },
        to: "jesse",
        addon: "evil",
        share: "bookclub",
      },
    });
    expect(await a.store.addons.grants(evil.id)).toHaveLength(1);
  });

  it("without addon-leave on the add-on's server, leaving still stops it calling", async () => {
    expectStatus(await give(a, jesse, evil.id, "bookclub", `conn:${ids.aSide}`), 201);
    await vi.waitFor(async () => expect(await b.store.addons.received(ids.bSide)).toHaveLength(1));
    await net.advertise("a.test", (doc) => ({
      ...doc,
      features: (doc.features as string[]).filter((f) => f !== "addon-leave"),
    }));
    expectStatus(
      await b.http("/addons/leave", {
        token: bob.token,
        body: { address: "jesse+evil+bookclub@a.test" },
      }),
      204,
    );
    expect(await a.store.addons.grants(evil.id)).toHaveLength(1); // a.test wasn't told
    evil.write({ t: "call.address", address: "bob@b.test", share: "bookclub" });
    expect(await evil.conn.nextState("ended")).toMatchObject({ reason: "unavailable" });
  });

  it("a reconnecting add-on is the same add-on: its key, not its claims, decides", async () => {
    // A second socket with the same key replaces the first; a hello naming another add-on's id
    // without its key gets a challenge it can't answer.
    const other = await HostileAddon.link(a, jesse, "other");
    const conn = await connectAddon(a, evil.id, evil.key);
    expect(evil.conn.closed?.code).toBe(4000);
    const fake = a.openDevice();
    fake.write({ ...SAMPLES.hello, deviceId: other.id });
    await fake.next("auth.challenge");
    fake.write({ t: "auth.proof", sig: "B".repeat(86) });
    expect((await fake.next("error")).message).toBe("bad signature");
    expect(conn.closed).toBeUndefined();
  });
});
