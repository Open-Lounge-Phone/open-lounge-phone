import { beforeEach, describe, expect, it } from "vitest";
import { type ConnectionHandler, Gateway } from "./gateway.ts";
import { LINE_WARNING } from "./lines.ts";
import { expectStatus, type FakeConn, Network, type TestServer } from "./testkit.ts";

/** A team space: its owner Olga, an admin Ada, and members Ben and Cy, with sessions. */
async function team(s: TestServer) {
  const olga = await s.person("olga", "Olga", "team");
  const hh = olga.household.id;
  const add = async (name: string, role: "guardian" | "contact") => {
    const user = await s.store.createUser({ householdId: hh, name, role }, s.timers.now);
    return { user, token: await s.store.createSession(user.id, s.timers.now) };
  };
  return {
    olga,
    hh,
    ada: await add("Ada", "guardian"),
    ben: await add("Ben", "contact"),
    cy: await add("Cy", "contact"),
  };
}
type Team = Awaited<ReturnType<typeof team>>;

/** A ring group "Support" (ext 300) with the given members. */
async function supportGroup(s: TestServer, t: Team, members: string[], extra: object = {}) {
  const r = await s.http("/groups", {
    token: t.ada.token,
    body: { name: "Support", extension: "300", members, ...extra },
  });
  expectStatus(r, 201);
  return r.json.id as string;
}

/** Publishes the group's line `acme-support@<host>` with these settings (confirming the warning). */
async function publish(s: TestServer, t: Team, groupId: string, settings: object = {}) {
  const r = await s.http(`/groups/${groupId}/line`, {
    method: "PUT",
    token: t.ada.token,
    body: { handle: "acme-support", enabled: true, confirm: true, ...settings },
  });
  expectStatus(r, 200);
  return r.json.line;
}

async function setLine(s: TestServer, t: Team, groupId: string, settings: object) {
  const r = await s.http(`/groups/${groupId}/line`, {
    method: "PUT",
    token: t.ada.token,
    body: settings,
  });
  expectStatus(r, 200);
}

/** Answers and exchanges offer/answer, so the call is active on both sides. */
async function talk(caller: FakeConn, callee: FakeConn, callerCall: string, calleeCall: string) {
  callee.write({ t: "call.answer", callId: calleeCall });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId: callerCall, type: "offer", sdp: "v=0 offer" });
  await callee.next("rtc.sdp");
  callee.write({ t: "rtc.sdp", callId: calleeCall, type: "answer", sdp: "v=0 answer" });
  await caller.nextState("active");
}

/** The line's first answer: `ringing` with its name, or `ended`. */
async function lineAnswer(conn: FakeConn) {
  for (;;) {
    const m = await conn.next("call.state");
    if (m.state === "ended" || m.line) return m;
  }
}

/** The next `call.state ringing` that carries a queue update. */
async function nextQueue(conn: FakeConn) {
  for (;;) {
    const m = await conn.nextState("ringing");
    if (m.queue) return m;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("public lines: publishing", () => {
  let s: TestServer;
  let t: Team;
  let groupId: string;
  beforeEach(async () => {
    s = new (await import("./testkit.ts")).TestServer({ publicUrl: "https://work.test" });
    t = await team(s);
    groupId = await supportGroup(s, t, [t.cy.user.id]);
  });

  it("is opt-in: off until an admin confirms the warning, and audited", async () => {
    const path = `/groups/${groupId}/line`;
    // Members can't; a new line needs an address and starts off.
    expectStatus(
      await s.http(path, { method: "PUT", token: t.ben.token, body: { handle: "acme-support" } }),
      403,
    );
    expectStatus(await s.http(path, { method: "PUT", token: t.ada.token, body: {} }), 400);
    const made = await s.http(path, {
      method: "PUT",
      token: t.ada.token,
      body: { handle: "acme-support" },
    });
    expectStatus(made, 200);
    expect(made.json.line).toMatchObject({
      address: "acme-support@work.test",
      enabled: false,
      who: "anyone",
      queue: true,
      queueMax: 10,
      queueWaitSeconds: 600,
      offerVoicemail: true,
      voicemail: true,
    });
    // Turning it on needs the warning confirmed.
    const unconfirmed = await s.http(path, {
      method: "PUT",
      token: t.ada.token,
      body: { enabled: true },
    });
    expectStatus(unconfirmed, 409);
    expect(unconfirmed.json.warning).toBe(LINE_WARNING);
    expect((await s.http(path, { token: t.ada.token })).json.line.enabled).toBe(false);
    expectStatus(
      await s.http(path, {
        method: "PUT",
        token: t.ada.token,
        body: { enabled: true, confirm: true },
      }),
      200,
    );
    expectStatus(
      await s.http(path, { method: "PUT", token: t.ada.token, body: { enabled: false } }),
      200,
    );
    const audit = (await s.http("/space/audit", { token: t.ada.token })).json.map(
      (e: { action: string }) => e.action,
    );
    expect(audit).toEqual(expect.arrayContaining(["line.address", "line.enable", "line.disable"]));
    // Groups and the directory show the address.
    const groups = (await s.http("/groups", { token: t.ben.token })).json;
    expect(groups[0].line).toEqual({
      handle: "acme-support",
      address: "acme-support@work.test",
      enabled: false,
    });
  });

  it("homes have no lines; addresses share the handle namespace", async () => {
    const home = await s.person("mom", "Mom");
    expectStatus(
      await s.http(`/groups/${groupId}/line`, {
        method: "PUT",
        token: home.token,
        body: { handle: "x1" },
      }),
      400,
    );
    // An account's handle is taken; a line's handle is taken for accounts and rooms.
    const taken = await s.http(`/groups/${groupId}/line`, {
      method: "PUT",
      token: t.ada.token,
      body: { handle: "olga" },
    });
    expectStatus(taken, 409);
    await publish(s, t, groupId);
    expect(await s.store.handleAvailable("acme-support", s.timers.now)).toBe(false);
    const room = await s.http("/rooms", {
      token: t.ada.token,
      body: { name: "Support room", kind: "phone", handle: "acme-support" },
    });
    expect(room.status).not.toBe(201);
  });

  it("checks settings: a line is never looser than the server, overflow stays in the space", async () => {
    await publish(s, t, groupId);
    const path = `/groups/${groupId}/line`;
    const bad = [
      { queueMax: 0 },
      { queueWaitSeconds: 5 },
      { callerPerHour: 0 },
      { who: "everyone" },
      { allow: ["not a host"] },
      { atMaxWait: { kind: "group", groupId } },
      { atMaxWait: { kind: "user", userId: "u_nobody" } },
    ];
    for (const body of bad) {
      expect((await s.http(path, { method: "PUT", token: t.ada.token, body })).status).toBe(400);
    }
    const ok = await s.http(path, {
      method: "PUT",
      token: t.ada.token,
      body: { callerPerHour: 3, allow: ["Far.Example", "ann@far.example"], displayName: "Acme" },
    });
    expect(ok.json.line).toMatchObject({
      callerPerHour: 3,
      allow: ["far.example", "ann@far.example"],
      limits: { callerPerHour: 10, serverPerHour: 300 },
    });
  });
});

describe("public lines: calls on one server", () => {
  let s: TestServer;
  let t: Team;
  let groupId: string;
  let ann: Awaited<ReturnType<TestServer["person"]>>;
  let dan: Awaited<ReturnType<TestServer["person"]>>;
  beforeEach(async () => {
    s = new (await import("./testkit.ts")).TestServer({ publicUrl: "https://work.test" });
    t = await team(s);
    groupId = await supportGroup(s, t, [t.cy.user.id], { ringSeconds: 10 });
    ann = await s.person("ann", "Ann");
    dan = await s.person("dan", "Dan");
  });

  it("an unknown, a disabled and a refusing line all answer the same: unavailable", async () => {
    const app = await s.connectApp(ann.token);
    const answers = [];
    app.write({ t: "call.line", address: "nosuch@work.test" });
    answers.push(await app.nextState("ended"));
    await s.http(`/groups/${groupId}/line`, {
      method: "PUT",
      token: t.ada.token,
      body: { handle: "acme-support" },
    });
    app.write({ t: "call.line", address: "acme-support@work.test" });
    answers.push(await app.nextState("ended"));
    await setLine(s, t, groupId, { enabled: true, confirm: true, who: "allowlist" });
    app.write({ t: "call.line", address: "acme-support@work.test" });
    answers.push(await app.nextState("ended"));
    for (const a of answers) {
      const { callId: _c, ...rest } = a;
      expect(rest).toEqual({ t: "call.state", state: "ended", reason: "unavailable" });
    }
  });

  it("queues callers in order with their place, rings when someone frees up", async () => {
    await publish(s, t, groupId, { displayName: "Acme support", description: "Help with orders" });
    const a1 = await s.connectApp(ann.token);
    const a2 = await s.connectApp(dan.token);
    // Cy (the only member) isn't online: Ann waits first, Dan second.
    a1.write({ t: "call.line", address: "acme-support@work.test" });
    const first = await lineAnswer(a1);
    expect(first.line).toEqual({
      name: "Acme support",
      description: "Help with orders",
      address: "acme-support@work.test",
    });
    expect((await nextQueue(a1)).queue).toEqual({ position: 1, size: 1, voicemail: true });
    a2.write({ t: "call.line", address: "acme-support@work.test" });
    expect((await nextQueue(a2)).queue).toEqual({ position: 2, size: 2, voicemail: true });
    expect((await nextQueue(a1)).queue).toEqual({ position: 1, size: 2, voicemail: true });
    // Cy comes online: the line rings her for Ann, showing Ann's verified address.
    const cy = await s.connectApp(t.cy.token);
    const ring = await cy.next("call.ringing");
    expect(ring.from).toEqual({ label: "Ann", address: "ann@work.test" });
    expect(ring.line?.name).toBe("Acme support");
    const ringingAgain = await a1.nextState("ringing");
    expect(ringingAgain.queue).toBeUndefined();
    expect((await nextQueue(a2)).queue).toEqual({ position: 1, size: 1, voicemail: true });
    await talk(a1, cy, ringingAgain.callId, ring.callId);
    // Ann hangs up: Cy is free, Dan rings.
    a1.write({ t: "call.hangup", callId: ring.callId });
    const ring2 = await cy.next("call.ringing");
    expect(ring2.from.address).toBe("dan@work.test");
    const callers = (await s.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(callers[0]).toMatchObject({ address: "ann@work.test", outcome: "answered" });
  });

  it("callers in the same millisecond keep the order they came in", async () => {
    await publish(s, t, groupId);
    const apps: FakeConn[] = [];
    for (const name of ["ann2", "bo", "cat", "dee", "eve"]) {
      const p = await s.person(name, name);
      const app = await s.connectApp(p.token);
      app.write({ t: "call.line", address: "acme-support@work.test" });
      expect((await nextQueue(app)).queue?.position).toBe(apps.length + 1);
      apps.push(app);
    }
    // The clock never moved, yet everyone is where they arrived.
    for (const [i, app] of apps.entries()) {
      expect(app.all("call.state").at(-1)?.queue).toMatchObject({ position: i + 1, size: 5 });
    }
  });

  it("an unanswered ring sends the caller back to their place", async () => {
    await publish(s, t, groupId);
    const cy = await s.connectApp(t.cy.token);
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await cy.next("call.ringing");
    s.timers.advance(10_000);
    await cy.nextState("ended");
    expect((await nextQueue(app)).queue).toMatchObject({ position: 1, size: 1 });
  });

  it("leave a voicemail instead: the wait ends with the line's offer, into its box", async () => {
    await publish(s, t, groupId);
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    const q = await nextQueue(app);
    app.write({ t: "call.voicemail", callId: q.callId });
    const ended = await app.nextState("ended");
    expect(ended).toMatchObject({ reason: "voicemail", voicemail: { name: "Support" } });
    const res = await s.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=3000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/wav",
    });
    expectStatus(res, 201);
    const inbox = (await s.http("/voicemails", { token: t.cy.token })).json;
    expect(inbox).toMatchObject([{ box: "Support", fromLabel: "Ann" }]);
  });

  it("without 'leave a voicemail instead' or without voicemail, waiting goes on", async () => {
    await publish(s, t, groupId, { offerVoicemail: false });
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    const q = await nextQueue(app);
    expect(q.queue).toEqual({ position: 1, size: 1 });
    app.write({ t: "call.voicemail", callId: q.callId });
    await settle();
    expect(app.all("call.state").filter((m) => m.state === "ended")).toEqual([]);
  });

  it("the longest wait offers voicemail; the longest line turns callers to voicemail", async () => {
    await publish(s, t, groupId, { queueMax: 1, queueWaitSeconds: 60 });
    const a1 = await s.connectApp(ann.token);
    const a2 = await s.connectApp(dan.token);
    a1.write({ t: "call.line", address: "acme-support@work.test" });
    await nextQueue(a1);
    a2.write({ t: "call.line", address: "acme-support@work.test" });
    const full = await a2.nextState("ended");
    expect(full).toMatchObject({ reason: "busy", voicemail: { name: "Support" } });
    s.timers.advance(60_000);
    const over = await a1.nextState("ended");
    expect(over).toMatchObject({ reason: "timeout", voicemail: { name: "Support" } });
  });

  it("at the longest wait: overflow to a person, or end with the line's words", async () => {
    await publish(s, t, groupId, {
      queueWaitSeconds: 30,
      atMaxWait: { kind: "user", userId: t.ben.user.id },
    });
    const ben = await s.connectApp(t.ben.token);
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await nextQueue(app);
    s.timers.advance(30_000);
    const ring = await ben.next("call.ringing");
    expect(ring.from.address).toBe("ann@work.test");
    app.write({ t: "call.hangup", callId: ring.callId });
    await ben.nextState("ended");
    await setLine(s, t, groupId, { atMaxWait: { kind: "end", message: "Call us tomorrow" } });
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await nextQueue(app);
    s.timers.advance(30_000);
    const ended = await app.nextState("ended");
    expect(ended).toMatchObject({ reason: "unavailable", note: "Call us tomorrow" });
    expect(ended.voicemail).toBeUndefined();
  });

  it("queue off: straight to voicemail; voicemail off: no offer at all", async () => {
    await publish(s, t, groupId, { queue: false });
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    expect(await app.nextState("ended")).toMatchObject({
      reason: "unavailable",
      voicemail: { name: "Support" },
    });
    await setLine(s, t, groupId, { voicemail: false });
    app.write({ t: "call.line", address: "acme-support@work.test" });
    const ended = await app.nextState("ended");
    expect(ended.reason).toBe("unavailable");
    expect(ended.voicemail).toBeUndefined();
  });

  it("after hours: the after-hours action, no queue", async () => {
    // Open Tuesday mornings only (it's Monday noon UTC in the tests).
    expectStatus(
      await s.http(`/groups/${groupId}`, {
        method: "PATCH",
        token: t.ada.token,
        body: { hours: [{ days: [2], start: "09:00", end: "10:00" }] },
      }),
      200,
    );
    await publish(s, t, groupId);
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    const ended = await app.nextState("ended");
    expect(ended).toMatchObject({ reason: "voicemail", note: "Closed right now" });
    expect(ended.voicemail?.name).toBe("Support");
    expect(app.all("call.state").some((m) => m.queue)).toBe(false);
  });

  it("blocked addresses and servers, the allow-list and 'connections only'", async () => {
    await publish(s, t, groupId);
    const app = await s.connectApp(ann.token);
    const tryCall = async () => {
      app.write({ t: "call.line", address: "acme-support@work.test" });
      const m = await lineAnswer(app);
      if (m.state === "ended") return m.reason;
      app.write({ t: "call.hangup", callId: m.callId });
      await app.nextState("ended");
      return "rang";
    };
    expect(await tryCall()).toBe("rang");
    const blocked = await s.http("/space/line-blocks", {
      token: t.ada.token,
      body: { entry: "Ann@work.test" },
    });
    expect(blocked.json).toEqual({ kind: "address", value: "ann@work.test" });
    expect(await tryCall()).toBe("unavailable");
    const callers = (await s.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(callers[0]).toMatchObject({ address: "ann@work.test", outcome: "refused" });
    expectStatus(
      await s.http("/space/line-blocks/address/ann%40work.test", {
        method: "DELETE",
        token: t.ada.token,
      }),
      204,
    );
    expect(await tryCall()).toBe("rang");
    // Members can't manage the blocklist.
    expectStatus(
      await s.http("/space/line-blocks", { token: t.ben.token, body: { entry: "x.example" } }),
      403,
    );
    // Only people connected to a member.
    await setLine(s, t, groupId, { who: "connections" });
    expect(await tryCall()).toBe("unavailable");
    // Members always get through.
    const ben = await s.connectApp(t.ben.token);
    ben.write({ t: "call.line", address: "acme-support@work.test" });
    expect((await lineAnswer(ben)).line?.address).toBe("acme-support@work.test");
    await setLine(s, t, groupId, { who: "allowlist", allow: ["ann@work.test"] });
    expect(await tryCall()).toBe("rang");
  });

  it("limits calls per caller (a line can be stricter than the server)", async () => {
    await publish(s, t, groupId, { callerPerHour: 2, queue: false, voicemail: false });
    const app = await s.connectApp(ann.token);
    const reasons: string[] = [];
    for (let i = 0; i < 3; i++) {
      app.write({ t: "call.line", address: "acme-support@work.test" });
      reasons.push((await app.nextState("ended")).reason as string);
    }
    // Two got in (nobody free, no queue), the third is refused, with the same answer.
    expect(reasons).toEqual(["unavailable", "unavailable", "unavailable"]);
    const callers = (await s.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(callers.map((c: { outcome: string }) => c.outcome)).toEqual([
      "refused",
      "nobody free",
      "nobody free",
    ]);
    s.timers.advance(60 * 60 * 1000);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await app.nextState("ended");
    const after = (await s.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(after[0].outcome).toBe("nobody free");
  });

  it("never a kids' phone: no line on its keys, and its call is refused", async () => {
    await publish(s, t, groupId);
    const kid = await s.pairDevice(ann.token, "Kid");
    if (!kid.deviceId || !kid.key) throw new Error("pairing failed");
    const add = await s.http(`/devices/${kid.deviceId}/lines`, {
      method: "PUT",
      token: ann.token,
      body: { address: "acme-support@work.test", label: "Support" },
    });
    expectStatus(add, 400);
    // Even if one got there, the phone's call is refused on its own server.
    const id = await s.store.lines.addToPhone(kid.deviceId, "acme-support@work.test", "Support");
    await s.store.setButton(kid.deviceId, 1, id);
    const phone = await s.connectDevice(kid.deviceId, kid.key.pair);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 1 });
    expect(await phone.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "Kids' phones can't call public lines",
    });
  });

  it("a line on a personal phone's key; the phone waits in line and leaves a voicemail", async () => {
    await publish(s, t, groupId);
    const desk = await s.pairDevice(ann.token, "Desk", { forMe: true });
    if (!desk.deviceId || !desk.key) throw new Error("pairing failed");
    const add = await s.http(`/devices/${desk.deviceId}/lines`, {
      method: "PUT",
      token: ann.token,
      body: { address: "acme-support@work.test", label: "Support" },
    });
    expectStatus(add, 200);
    expectStatus(
      await s.http(`/devices/${desk.deviceId}/buttons/2`, {
        method: "PUT",
        token: ann.token,
        body: { userId: add.json.id },
      }),
      204,
    );
    const phone = await s.connectDevice(desk.deviceId, desk.key.pair);
    expect(phone.all("config").at(-1)?.buttons).toEqual([{ index: 2, label: "Support" }]);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 2 });
    const q = await nextQueue(phone);
    expect(q.queue).toEqual({ position: 1, size: 1, voicemail: true });
    phone.write({ t: "call.voicemail", callId: q.callId });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "voicemail" });
  });

  it("a waiting call survives the host sleeping: its place and its longest wait", async () => {
    await publish(s, t, groupId, { queueWaitSeconds: 120 });
    // Ben (a member) calls his own team's line; nobody is free.
    const app = await s.connectApp(t.ben.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await nextQueue(app);
    const saved = s.savedRooms.get(t.hh) ?? [];
    expect(saved).toMatchObject([
      {
        line: {
          groupId,
          waiting: true,
          address: "ben@work.test",
          waitUntil: s.timers.now + 120_000,
        },
      },
    ]);
    // The host sleeps: its timers are gone, a new gateway resumes from what it saved.
    for (const timer of (s.timers as unknown as { timers: { live: boolean }[] }).timers) {
      timer.live = false;
    }
    const gateway = new Gateway(s.env);
    const [handler] = gateway.resume([{ conn: app, memo: app.memo, app: true }], (hh) =>
      structuredClone(s.savedRooms.get(hh) ?? []),
    );
    app.handler = handler as ConnectionHandler;
    s.timers.advance(120_000);
    expect(await app.nextState("ended")).toMatchObject({
      reason: "timeout",
      voicemail: { name: "Support" },
    });
  });

  it("the longest wait running out while members ring applies when the ring ends", async () => {
    const other = await s.http("/groups", {
      token: t.ada.token,
      body: { name: "Sales", extension: "301", members: [t.ben.user.id] },
    });
    await publish(s, t, groupId, {
      queueWaitSeconds: 30,
      atMaxWait: { kind: "group", groupId: other.json.id },
    });
    const cy = await s.connectApp(t.cy.token);
    const ben = await s.connectApp(t.ben.token);
    const app = await s.connectApp(ann.token);
    app.write({ t: "call.line", address: "acme-support@work.test" });
    await cy.next("call.ringing");
    // Cy doesn't answer (10 s): Ann goes back to her place.
    s.timers.advance(10_000);
    await cy.nextState("ended");
    await nextQueue(app);
    // At 25 s Cy opens the app on another device: the line rings her again for Ann...
    s.timers.advance(15_000);
    const cy2 = await s.connectApp(t.cy.token);
    await cy2.next("call.ringing");
    // ...and the longest wait (30 s) runs out while she rings: nothing happens yet.
    s.timers.advance(5_000);
    await settle();
    expect(ben.all("call.ringing")).toEqual([]);
    // Nobody answers: then the overflow group (Sales) rings for Ann.
    s.timers.advance(5_000);
    const sales = await ben.next("call.ringing");
    expect(sales.from.address).toBe("ann@work.test");
    ben.write({ t: "call.hangup", callId: sales.callId });
    const ended = await app.nextState("ended");
    expect(ended).toMatchObject({ reason: "timeout", voicemail: { name: "Sales" } });
  });
});

describe("public lines across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let t: Team;
  let groupId: string;
  let bob: Awaited<ReturnType<TestServer["person"]>>;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test");
    b = await net.server("b.test");
    t = await team(a);
    groupId = await supportGroup(a, t, [t.cy.user.id], { ringSeconds: 10 });
    bob = await b.person("bob", "Bob");
  });

  it("someone on another server waits in line, then leaves a voicemail through their server", async () => {
    await publish(a, t, groupId, { displayName: "Acme support" });
    const app = await b.connectApp(bob.token);
    app.write({ t: "call.line", address: "acme-support@a.test" });
    const ringing = await app.nextState("ringing");
    const named = await app.nextState("ringing");
    expect(named.line?.name).toBe("Acme support");
    const q = await nextQueue(app);
    expect(q.callId).toBe(ringing.callId);
    expect(q.queue).toEqual({ position: 1, size: 1, voicemail: true });
    app.write({ t: "call.voicemail", callId: q.callId });
    const ended = await app.nextState("ended");
    expect(ended).toMatchObject({ reason: "voicemail", voicemail: { name: "Support" } });
    // Bob's server issued the ticket; the message lands in the team's shared box.
    const res = await b.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=3000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/wav",
    });
    expectStatus(res, 201);
    const inbox = (await a.http("/voicemails", { token: t.cy.token })).json;
    expect(inbox).toMatchObject([{ box: "Support", fromLabel: "Bob" }]);
  });

  it("a member answers someone from another server; the call log names them", async () => {
    await publish(a, t, groupId);
    const cy = await a.connectApp(t.cy.token);
    const app = await b.connectApp(bob.token);
    app.write({ t: "call.line", address: "acme-support@a.test" });
    const ring = await cy.next("call.ringing");
    expect(ring.from).toEqual({ label: "Bob", address: "bob@b.test" });
    const bCall = (await app.nextState("ringing")).callId;
    await talk(app, cy, bCall, ring.callId);
    app.write({ t: "call.hangup", callId: bCall });
    await cy.nextState("ended");
    const callers = (await a.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(callers[0]).toMatchObject({
      address: "bob@b.test",
      server: "b.test",
      outcome: "answered",
    });
  });

  it("blocks a whole server; refuses calls flagged as from a kids' phone; no feature, no call", async () => {
    await publish(a, t, groupId);
    const app = await b.connectApp(bob.token);
    await a.http("/space/line-blocks", { token: t.ada.token, body: { entry: "b.test" } });
    app.write({ t: "call.line", address: "acme-support@a.test" });
    expect((await app.nextState("ended")).reason).toBe("unavailable");
    await a.http("/space/line-blocks/server/b.test", { method: "DELETE", token: t.ada.token });
    // A kids' phone calling through its guardian is refused by the line's server too.
    const kids = await a.env.calls?.receive("b.test", {
      callId: "call_kid1",
      from: { handle: "bob", id: bob.account.id, name: "Bob" },
      to: { kind: "line", handle: "acme-support" },
      viaPhone: { label: "Kid" },
    });
    expect(kids).toEqual({ state: "ended", reason: "unavailable" });
    // A server that doesn't advertise public lines is never asked.
    await net.advertise("a.test", (d) => ({
      ...d,
      features: (d.features as string[]).filter((f) => f !== "public-lines"),
    }));
    app.write({ t: "call.line", address: "acme-support@a.test" });
    expect(await app.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "That server doesn't take calls to public lines yet",
    });
  });

  it("limits calls per server", async () => {
    await publish(a, t, groupId, { serverPerHour: 1, queue: false, voicemail: false });
    const app = await b.connectApp(bob.token);
    app.write({ t: "call.line", address: "acme-support@a.test" });
    await app.nextState("ended");
    const carl = await b.person("carl", "Carl");
    const app2 = await b.connectApp(carl.token);
    app2.write({ t: "call.line", address: "acme-support@a.test" });
    await app2.nextState("ended");
    const callers = (await a.http(`/groups/${groupId}/line/callers`, { token: t.ada.token })).json;
    expect(
      callers.map((c: { address: string; outcome: string }) => [c.address, c.outcome]),
    ).toEqual([
      ["carl@b.test", "refused"],
      ["bob@b.test", "nobody free"],
    ]);
  });
});
