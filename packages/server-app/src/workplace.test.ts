import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, type FakeConn, Network, type TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

/** A team space: its owner Olga, an admin Ada, and members Ben and Cy, with sessions. */
async function team(s: TestServer) {
  const olga = await s.person("olga", "Olga", "team");
  const hh = olga.household.id;
  const add = async (name: string, role: "guardian" | "contact") => {
    const user = await s.store.createUser({ householdId: hh, name, role }, s.timers.now);
    const account = await s.store.getAccount(user.accountId);
    return { user, token: await s.store.createSession(user.id, s.timers.now), account };
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

async function ext(s: TestServer, token: string, number: string, kind: string, targetId: string) {
  return s.http(`/extensions/${number}`, { method: "PUT", token, body: { kind, targetId } });
}

async function group(
  s: TestServer,
  token: string,
  body: {
    name: string;
    extension: string;
    strategy?: string;
    ringSeconds?: number;
    members: string[];
  },
) {
  const r = await s.http("/groups", { token, body });
  expectStatus(r, 201);
  return r.json as { id: string; extension: string };
}

/** Answers and exchanges offer/answer, so the call is active on both sides. */
async function talk(caller: FakeConn, callee: FakeConn, callId: string) {
  callee.write({ t: "call.answer", callId });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
  await callee.next("rtc.sdp");
  callee.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 answer" });
  await caller.next("rtc.sdp");
  await caller.nextState("active");
  await callee.nextState("active");
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("team and org spaces: directory, extensions, roles", () => {
  let s: TestServer;
  let t: Team;
  beforeEach(async () => {
    s = new (await import("./testkit.ts")).TestServer({ publicUrl: "https://work.test" });
    t = await team(s);
  });

  it("members see a searchable directory; admins give out extensions", async () => {
    expectStatus(await ext(s, t.ada.token, "201", "user", t.ben.user.id), 204);
    const dir = await s.http("/directory", { token: t.cy.token });
    expectStatus(dir, 200);
    expect(dir.json.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Olga", role: "owner", address: "olga@work.test" }),
        expect.objectContaining({ name: "Ada", role: "admin" }),
        expect.objectContaining({ name: "Ben", role: "member", extension: "201" }),
      ]),
    );
    expect(dir.json.you).toEqual({ id: t.cy.user.id, role: "member" });
    const found = await s.http("/directory?q=20", { token: t.cy.token });
    expect(found.json.members.map((m: { name: string }) => m.name)).toEqual(["Ben"]);
    // Members can't hand out numbers; numbers are unique; targets must be in the space.
    expectStatus(await ext(s, t.cy.token, "202", "user", t.cy.user.id), 403);
    expectStatus(await ext(s, t.ada.token, "201", "user", t.cy.user.id), 409);
    const stranger = await s.person("zed", "Zed", "team");
    expectStatus(await ext(s, t.ada.token, "203", "user", stranger.user.id), 400);
    expectStatus(await ext(s, t.ada.token, "2", "user", t.cy.user.id), 400);
    // A new number for Ben replaces his old one.
    expectStatus(await ext(s, t.ada.token, "210", "user", t.ben.user.id), 204);
    const list = await s.http("/extensions", { token: t.cy.token });
    expect(list.json.map((e: { number: string }) => e.number)).toEqual(["210"]);
    expectStatus(await s.http("/extensions/210", { method: "DELETE", token: t.ben.token }), 403);
    expectStatus(await s.http("/extensions/210", { method: "DELETE", token: t.ada.token }), 204);
  });

  it("homes have none of it", async () => {
    const home = await s.person("mom", "Mom");
    expectStatus(await s.http("/directory", { token: home.token }), 400);
    expectStatus(await ext(s, home.token, "201", "user", home.user.id), 400);
    expectStatus(
      await s.http("/groups", {
        token: home.token,
        body: { name: "G", extension: "300", members: [] },
      }),
      400,
    );
    expectStatus(await s.http("/space/calls", { token: home.token }), 400);
    // Even a number that got into a home's data isn't dialed there.
    const dad = await s.store.createUser(
      { householdId: home.household.id, name: "Dad", role: "contact" },
      s.timers.now,
    );
    await s.store.workplace.setExtension(
      { householdId: home.household.id, number: "201", kind: "user", targetId: dad.id },
      s.timers.now,
    );
    const app = await s.connectApp(home.token);
    app.write({ t: "call.extension", number: "201" });
    expect(await app.nextState("ended")).toMatchObject({ reason: "denied" });
  });

  it("only the owner makes and unmakes admins; the owner stays", async () => {
    const promote = (token: string, id: string, role: string) =>
      s.http(`/users/${id}/role`, { method: "PATCH", token, body: { role } });
    expectStatus(await promote(t.ada.token, t.ben.user.id, "admin"), 403);
    expectStatus(await promote(t.olga.token, t.ben.user.id, "admin"), 204);
    expect((await s.store.getUser(t.ben.user.id))?.role).toBe("guardian");
    expectStatus(await promote(t.olga.token, t.olga.user.id, "member"), 403);
    expectStatus(await promote(t.olga.token, t.ben.user.id, "member"), 204);
    // Admins can't invite admins or remove them; the owner can.
    expectStatus(
      await s.http("/invites", { token: t.ada.token, body: { name: "Dee", role: "guardian" } }),
      403,
    );
    expectStatus(
      await s.http("/invites", { token: t.ada.token, body: { name: "Dee", role: "contact" } }),
      201,
    );
    expectStatus(
      await s.http(`/users/${t.olga.user.id}`, { method: "DELETE", token: t.ada.token }),
      403,
    );
    expectStatus(
      await s.http(`/users/${t.ada.user.id}`, { method: "DELETE", token: t.olga.token }),
      204,
    );
  });

  it("the audit trail records who changed what; only admins read it; it expires with history", async () => {
    await ext(s, t.ada.token, "201", "user", t.ben.user.id);
    await s.http(`/users/${t.cy.user.id}/role`, {
      method: "PATCH",
      token: t.olga.token,
      body: { role: "admin" },
    });
    const log = await s.http("/space/audit", { token: t.olga.token });
    expectStatus(log, 200);
    expect(
      log.json.map((e: { action: string; actorName: string }) => [e.action, e.actorName]),
    ).toEqual([
      ["role.change", "Olga"],
      ["extension.set", "Ada"],
    ]);
    expectStatus(await s.http("/space/audit", { token: t.ben.token }), 403);
    // A year's retention: older audit rows go with the sweep.
    await s.http("/space/privacy", {
      method: "PUT",
      token: t.olga.token,
      body: { history: "30d" },
    });
    s.timers.advance(31 * 24 * 60 * 60 * 1000);
    await s.store.sweepExpired(t.hh, "work.test", s.timers.now);
    const after = await s.http("/space/audit", { token: t.olga.token });
    expect(after.json.map((e: { action: string }) => e.action)).toEqual([]);
  });
});

describe("team and org spaces: dialing extensions and ring groups", () => {
  let s: TestServer;
  let t: Team;
  beforeEach(async () => {
    s = new (await import("./testkit.ts")).TestServer({ publicUrl: "https://work.test" });
    t = await team(s);
  });

  it("an app dials a member's extension; an unknown number is refused", async () => {
    await ext(s, t.ada.token, "201", "user", t.ben.user.id);
    const cy = await s.connectApp(t.cy.token);
    const ben = await s.connectApp(t.ben.token);
    cy.write({ t: "call.extension", number: "201" });
    const ring = await ben.next("call.ringing");
    expect(ring.from.label).toBe("Cy");
    await talk(cy, ben, ring.callId);
    cy.write({ t: "call.hangup", callId: ring.callId });
    await ben.nextState("ended");
    await cy.nextState("ended");
    cy.write({ t: "call.extension", number: "999" });
    expect(await cy.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "No such extension",
    });
  });

  it("a simultaneous group rings everyone; the first to answer takes it", async () => {
    const g = await group(s, t.ada.token, {
      name: "Front desk",
      extension: "100",
      members: [t.ben.user.id, t.cy.user.id],
    });
    expect(g.extension).toBe("100");
    const olga = await s.connectApp(t.olga.token);
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    olga.write({ t: "call.extension", number: "100" });
    const rb = await ben.next("call.ringing");
    const rc = await cy.next("call.ringing");
    expect(rc.callId).toBe(rb.callId);
    // Ben declines: only he stops ringing; Cy still rings and answers.
    ben.write({ t: "call.hangup", callId: rb.callId });
    await ben.nextState("ended");
    await settle();
    expect(cy.all("call.state").filter((m) => m.state === "ended")).toEqual([]);
    await talk(olga, cy, rc.callId);
    olga.write({ t: "call.hangup", callId: rc.callId });
    await cy.nextState("ended");
    // The caller's log names the group's answerer; the space log has both sides.
    await vi.waitFor(async () =>
      expect((await s.http("/space/calls", { token: t.ada.token })).json).toHaveLength(2),
    );
  });

  it("sequential: one after another, then the group's shared box; heard by one, seen by all", async () => {
    await group(s, t.ada.token, {
      name: "Support",
      extension: "300",
      strategy: "sequential",
      ringSeconds: 10,
      members: [t.ben.user.id, t.cy.user.id],
    });
    const olga = await s.connectApp(t.olga.token);
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    olga.write({ t: "call.extension", number: "300" });
    const rb = await ben.next("call.ringing");
    await settle();
    expect(cy.all("call.ringing")).toEqual([]);
    s.timers.advance(10_000);
    await ben.nextState("ended");
    const rc = await cy.next("call.ringing");
    expect(rc.callId).toBe(rb.callId);
    s.timers.advance(10_000);
    const ended = await olga.nextState("ended");
    expect(ended.reason).toBe("timeout");
    expect(ended.voicemail?.name).toBe("Support");
    // The caller leaves a message in the group's box.
    const res = await s.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=4000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/webm",
    });
    expectStatus(res, 201);
    expect(await ben.next("voicemail.inbox")).toMatchObject({ box: "Support", from: "Olga" });
    const inbox = (await s.http("/voicemails", { token: t.cy.token })).json;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ box: "Support", heardAt: null });
    expectStatus(
      await s.http(`/voicemails/${inbox[0].id}/heard`, { method: "POST", token: t.cy.token }),
      204,
    );
    const seen = (await s.http("/voicemails", { token: t.ben.token })).json;
    expect(seen[0]).toMatchObject({ heardByName: "Cy" });
    // Not in the group and not an admin: not yours to hear.
    const dee = await s.store.createUser({ householdId: t.hh, name: "Dee", role: "contact" }, 0);
    const deeToken = await s.store.createSession(dee.id, s.timers.now);
    expect((await s.http("/voicemails", { token: deeToken })).json).toEqual([]);
    expectStatus(await s.http(`/voicemails/${inbox[0].id}/audio`, { token: deeToken }), 404);
    // Admins see every box.
    expect((await s.http("/voicemails", { token: t.ada.token })).json).toHaveLength(1);
  });

  it("round robin starts with the next member each call", async () => {
    await group(s, t.ada.token, {
      name: "Sales",
      extension: "400",
      strategy: "round_robin",
      members: [t.ben.user.id, t.cy.user.id],
    });
    const olga = await s.connectApp(t.olga.token);
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    olga.write({ t: "call.extension", number: "400" });
    const first = await ben.next("call.ringing");
    olga.write({ t: "call.hangup", callId: first.callId });
    await ben.nextState("ended");
    await olga.nextState("ended");
    olga.write({ t: "call.extension", number: "400" });
    const second = await cy.next("call.ringing");
    expect(second.callId).not.toBe(first.callId);
    await settle();
    expect(ben.all("call.ringing")).toHaveLength(1);
  });

  it("business hours: closed → voicemail, or forward once to a group or a member", async () => {
    const support = await group(s, t.ada.token, {
      name: "Support",
      extension: "300",
      members: [t.ben.user.id],
    });
    const night = await group(s, t.ada.token, {
      name: "Night",
      extension: "301",
      members: [t.cy.user.id],
    });
    // Monday noon UTC; open only in the morning.
    const morning = { hours: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "11:00" }] };
    expectStatus(
      await s.http("/space/hours", { method: "PUT", token: t.ben.token, body: morning }),
      403,
    );
    expectStatus(
      await s.http("/space/hours", { method: "PUT", token: t.ada.token, body: morning }),
      204,
    );
    const olga = await s.connectApp(t.olga.token);
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    olga.write({ t: "call.extension", number: "300" });
    const closed = await olga.nextState("ended");
    expect(closed).toMatchObject({ reason: "voicemail", note: "Closed right now" });
    expect(closed.voicemail?.name).toBe("Support");
    // Support forwards to Night after hours; Night (also closed) doesn't forward again.
    expectStatus(
      await s.http(`/groups/${support.id}`, {
        method: "PATCH",
        token: t.ada.token,
        body: { afterHours: { kind: "group", groupId: night.id } },
      }),
      200,
    );
    expectStatus(
      await s.http(`/groups/${night.id}`, {
        method: "PATCH",
        token: t.ada.token,
        body: { afterHours: { kind: "group", groupId: support.id } },
      }),
      200,
    );
    olga.write({ t: "call.extension", number: "300" });
    const toNight = await olga.nextState("ended");
    expect(toNight.voicemail?.name).toBe("Night");
    // Night has its own hours (evenings too): open now, so it rings Cy.
    expectStatus(
      await s.http(`/groups/${night.id}`, {
        method: "PATCH",
        token: t.ada.token,
        body: { hours: [{ days: [1], start: "11:00", end: "23:00" }] },
      }),
      200,
    );
    olga.write({ t: "call.extension", number: "300" });
    const ring = await cy.next("call.ringing");
    olga.write({ t: "call.hangup", callId: ring.callId });
    await cy.nextState("ended");
    await olga.nextState("ended");
    // Forward to a member instead.
    await s.http(`/groups/${support.id}`, {
      method: "PATCH",
      token: t.ada.token,
      body: { afterHours: { kind: "user", userId: t.ben.user.id } },
    });
    olga.write({ t: "call.extension", number: "300" });
    expect((await ben.next("call.ringing")).from.label).toBe("Olga");
  });

  it("admins read and export the space's call log; members can't", async () => {
    await ext(s, t.ada.token, "201", "user", t.ben.user.id);
    const cy = await s.connectApp(t.cy.token);
    const ben = await s.connectApp(t.ben.token);
    cy.write({ t: "call.extension", number: "201" });
    const ring = await ben.next("call.ringing");
    await talk(cy, ben, ring.callId);
    s.timers.advance(65_000);
    cy.write({ t: "call.hangup", callId: ring.callId });
    await ben.nextState("ended");
    await vi.waitFor(async () =>
      expect((await s.http("/space/calls", { token: t.olga.token })).json).toHaveLength(2),
    );
    const log = (await s.http("/space/calls", { token: t.olga.token })).json;
    expect(log.map((r: { who: string; direction: string }) => [r.who, r.direction]).sort()).toEqual(
      [
        ["Ben", "in"],
        ["Cy", "out"],
      ],
    );
    expectStatus(await s.http("/space/calls", { token: t.cy.token }), 403);
    const csv = await s.api.request("/space/calls.csv", {
      headers: { authorization: `Bearer ${t.olga.token}` },
    });
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe(
      "started,direction,who,peer,peer_label,answered,duration_s,end_reason,voicemail,recording",
    );
    expect(text).toMatch(/,Cy,user:[^,]+,Ben,yes,65,hangup,no,no/);
    // Exporting is itself in the audit trail.
    const audit = (await s.http("/space/audit", { token: t.olga.token })).json;
    expect(audit[0]).toMatchObject({ action: "calls.export", actorName: "Olga" });
  });

  it("a desk phone gets MENU → Dial extension and dials one", async () => {
    const paired = await s.pairDevice(t.ben.token, "Ben's desk", { forMe: true });
    if (!paired.deviceId || !paired.key) throw new Error("pairing failed");
    let phone = await s.connectDevice(paired.deviceId, paired.key.pair);
    expect(phone.all("config").at(-1)?.extensions).toBeUndefined();
    await ext(s, t.ada.token, "202", "user", t.cy.user.id);
    phone = await s.connectDevice(paired.deviceId, paired.key.pair);
    expect(phone.all("config").at(-1)?.extensions).toBe(true);
    const cy = await s.connectApp(t.cy.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.extension", number: "202" });
    expect((await cy.next("call.ringing")).from.label).toBe("Ben");
  });
});

describe("transfer across servers (team/org spaces only)", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let t: Team;
  let bob: Person;
  let connId: string;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test");
    b = await net.server("b.test");
    t = await team(a);
    bob = await b.person("bob", "Bob");
    // Bob and Olga (the team's owner, whose first space is the team) are connected.
    expectStatus(
      await b.http("/connections", { token: bob.token, body: { to: t.olga.address } }),
      202,
    );
    const inbox = await a.http("/connections", { token: t.olga.token });
    const req = inbox.json.connections.find((c: { address: string }) => c.address === bob.address);
    expectStatus(
      await a.http(`/connections/${req.id}/accept`, { method: "POST", token: t.olga.token }),
      200,
    );
    connId = (await b.http("/connections", { token: bob.token })).json.connections[0].id;
  });

  async function bobCallsOlga() {
    const bApp = await b.connectApp(bob.token);
    const olga = await a.connectApp(t.olga.token);
    bApp.write({ t: "call.connection", connectionId: connId });
    const ring = await olga.next("call.ringing");
    const bCall = (await bApp.nextState("ringing")).callId;
    olga.write({ t: "call.answer", callId: ring.callId });
    await bApp.nextState("connecting");
    bApp.write({ t: "rtc.sdp", callId: bCall, type: "offer", sdp: "v=0 o" });
    await olga.next("rtc.sdp");
    olga.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a" });
    await bApp.nextState("active");
    await olga.nextState("active");
    return { bApp, olga, bCall, aCall: ring.callId };
  }

  it("blind: Bob (another server) is handed to a ring group; his server carries him over", async () => {
    await group(a, t.ada.token, { name: "Support", extension: "300", members: [t.cy.user.id] });
    const cy = await a.connectApp(t.cy.token);
    const { bApp, olga, aCall } = await bobCallsOlga();
    olga.write({ t: "call.transfer", callId: aCall, to: { extension: "300" } });
    expect(await olga.nextState("ended")).toMatchObject({ reason: "hangup" });
    const moved = await bApp.nextState("ended");
    expect(moved.transfer).toMatchObject({ ringing: true, offerer: true });
    const ring = await cy.next("call.ringing");
    expect(ring.from.label).toBe("Bob");
    const next = moved.transfer?.callId as string;
    // Cy answers; Bob (the new call's caller) offers, and the signaling crosses the servers.
    cy.write({ t: "call.answer", callId: ring.callId });
    expect(await bApp.nextState("connecting")).toMatchObject({ callId: next });
    bApp.write({ t: "rtc.sdp", callId: next, type: "offer", sdp: "v=0 o2" });
    expect(await cy.next("rtc.sdp")).toMatchObject({ callId: ring.callId, sdp: "v=0 o2" });
    cy.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a2" });
    expect(await bApp.next("rtc.sdp")).toMatchObject({ callId: next, sdp: "v=0 a2" });
    await bApp.nextState("active");
    await cy.nextState("active");
    bApp.write({ t: "call.hangup", callId: next });
    await cy.nextState("ended");
  });

  it("blind, unanswered: Bob gets the ring group's voicemail offer, as a caller from here would", async () => {
    await group(a, t.ada.token, {
      name: "Support",
      extension: "300",
      ringSeconds: 10,
      members: [t.cy.user.id],
    });
    const cy = await a.connectApp(t.cy.token);
    const { bApp, olga, aCall } = await bobCallsOlga();
    olga.write({ t: "call.transfer", callId: aCall, to: { extension: "300" } });
    const next = (await bApp.nextState("ended")).transfer?.callId as string;
    await cy.next("call.ringing");
    // Nobody in the group answers.
    a.timers.advance(10_000);
    await cy.nextState("ended");
    const ended = await bApp.nextState("ended");
    expect(ended).toMatchObject({ callId: next, reason: "timeout" });
    expect(ended.voicemail?.name).toBe("Support");
    // Bob's own server issued the ticket; greeting and message go through it to the team's box.
    const greeting = await b.http(`/vm/greeting?ticket=${ended.voicemail?.ticket}`);
    expect(greeting.status).toBe(204);
    const res = await b.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=4000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/webm",
    });
    expectStatus(res, 201);
    expect(await cy.next("voicemail.inbox")).toMatchObject({ box: "Support", from: "Bob" });
    const inbox = (await a.http("/voicemails", { token: t.cy.token })).json;
    expect(inbox).toMatchObject([{ box: "Support", fromLabel: "Bob" }]);
    // The ticket is single-use on both servers.
    const again = await b.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=4000`, {
      raw: new Uint8Array([1]),
      type: "audio/webm",
    });
    expectStatus(again, 404);
  });

  it("unanswered transfer from another household on the same server: the same offer", async () => {
    await group(a, t.ada.token, {
      name: "Support",
      extension: "300",
      ringSeconds: 10,
      members: [t.cy.user.id],
    });
    const hal = await a.person("hal", "Hal");
    expectStatus(
      await a.http("/connections", { token: hal.token, body: { to: t.olga.address } }),
      202,
    );
    const knock = (await a.http("/connections", { token: t.olga.token })).json.connections.find(
      (c: { address: string }) => c.address === hal.address,
    );
    await a.http(`/connections/${knock.id}/accept`, { method: "POST", token: t.olga.token });
    const toOlga = (await a.http("/connections", { token: hal.token })).json.connections[0].id;
    const hApp = await a.connectApp(hal.token);
    const olga = await a.connectApp(t.olga.token);
    const cy = await a.connectApp(t.cy.token);
    hApp.write({ t: "call.connection", connectionId: toOlga });
    const ring = await olga.next("call.ringing");
    await talk(hApp, olga, ring.callId).catch(() => {});
    olga.write({ t: "call.transfer", callId: ring.callId, to: { extension: "300" } });
    expect((await hApp.nextState("ended")).transfer).toMatchObject({ ringing: true });
    await cy.next("call.ringing");
    a.timers.advance(10_000);
    const ended = await hApp.nextState("ended");
    expect(ended.voicemail?.name).toBe("Support");
    const res = await a.http(`/vm/message?ticket=${ended.voicemail?.ticket}&durationMs=4000`, {
      raw: new Uint8Array([1, 2, 3]),
      type: "audio/webm",
    });
    expectStatus(res, 201);
    expect(await cy.next("voicemail.inbox")).toMatchObject({ box: "Support", from: "Hal" });
  });

  it("attended: Olga holds Bob, calls Ben, and connects them", async () => {
    const ben = await a.connectApp(t.ben.token);
    const { bApp, olga, aCall } = await bobCallsOlga();
    olga.write({ t: "call.hold", callId: aCall, hold: true });
    await bApp.nextState("active");
    olga.write({ t: "call.user", userId: t.ben.user.id });
    const ring = await ben.next("call.ringing");
    const consult = (await olga.nextState("ringing")).callId;
    ben.write({ t: "call.answer", callId: ring.callId });
    await olga.nextState("connecting");
    olga.write({ t: "rtc.sdp", callId: consult, type: "offer", sdp: "v=0 x" });
    await ben.next("rtc.sdp");
    ben.write({ t: "rtc.sdp", callId: consult, type: "answer", sdp: "v=0 y" });
    await olga.nextState("active");
    olga.write({ t: "call.transfer", callId: aCall, toCall: consult });
    const bMoved = (await bApp.nextState("ended")).transfer;
    const benMoved = (await ben.nextState("ended")).transfer;
    expect(bMoved).toMatchObject({ ringing: false, offerer: true });
    expect(benMoved).toMatchObject({ ringing: false, offerer: false });
    await bApp.nextState("connecting");
    await ben.nextState("connecting");
    bApp.write({ t: "rtc.sdp", callId: bMoved?.callId as string, type: "offer", sdp: "v=0 z" });
    expect(await ben.next("rtc.sdp")).toMatchObject({ callId: benMoved?.callId, sdp: "v=0 z" });
  });

  it("refused outside the space: to a connection, or from a home", async () => {
    const { olga, aCall } = await bobCallsOlga();
    olga.write({ t: "call.transfer", callId: aCall, to: { connectionId: "c_x" } });
    expect((await olga.next("error")).message).toMatch(/only to people, phones, ring groups/);
    // A member of another space on the same server isn't a target either.
    const other = await a.person("zed", "Zed", "team");
    olga.write({ t: "call.transfer", callId: aCall, to: { userId: other.user.id } });
    expect((await olga.next("error")).message).toMatch(/only to people, phones, ring groups/);
  });

  it("a kids' phone on another server is never transferred: its server ends the call", async () => {
    // Bob's home on b has a kids' phone with Olga (through Bob's connection) on a key.
    const paired = await b.pairDevice(bob.token, "Kid");
    if (!paired.deviceId || !paired.key) throw new Error("pairing failed");
    const rc = await b.http(`/devices/${paired.deviceId}/remote-contacts/${connId}`, {
      method: "PUT",
      token: bob.token,
      body: { label: "Olga", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
    });
    expectStatus(rc, 200);
    expectStatus(
      await b.http(`/devices/${paired.deviceId}/buttons/1`, {
        method: "PUT",
        token: bob.token,
        body: { userId: rc.json.id },
      }),
      204,
    );
    const kid = await b.connectDevice(paired.deviceId, paired.key.pair);
    const olga = await a.connectApp(t.olga.token);
    const ben = await a.connectApp(t.ben.token);
    kid.write({ t: "hook", state: "up" });
    kid.write({ t: "button", index: 1 });
    const ring = await olga.next("call.ringing");
    const kCall = (await kid.nextState("ringing")).callId;
    olga.write({ t: "call.answer", callId: ring.callId });
    await kid.nextState("connecting");
    kid.write({ t: "rtc.sdp", callId: kCall, type: "offer", sdp: "v=0 o" });
    await olga.next("rtc.sdp");
    olga.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a" });
    await kid.nextState("active");
    // Olga's team may hand Bob's side on, but the kids' phone's own server refuses to follow.
    olga.write({ t: "call.transfer", callId: ring.callId, to: { userId: t.ben.user.id } });
    const ended = await kid.nextState("ended");
    expect(ended.transfer).toBeUndefined();
    expect(ended.reason).toBe("hangup");
    // Ben rang for the transfer; with nobody following on the other side it stops at once.
    await ben.next("call.ringing");
    expect(await ben.nextState("ended")).toMatchObject({ reason: "hangup" });
  });

  it("a home refuses to transfer someone from another server", async () => {
    const mom = await a.person("mom", "Mom");
    const dad = await a.store.createUser(
      { householdId: mom.household.id, name: "Dad", role: "contact" },
      a.timers.now,
    );
    expectStatus(
      await b.http("/connections", { token: bob.token, body: { to: mom.address } }),
      202,
    );
    const req = (await a.http("/connections", { token: mom.token })).json.connections.find(
      (c: { address: string }) => c.address === bob.address,
    );
    await a.http(`/connections/${req.id}/accept`, { method: "POST", token: mom.token });
    const bConn = (await b.http("/connections", { token: bob.token })).json.connections.find(
      (c: { address: string }) => c.address === mom.address,
    ).id;
    const bApp = await b.connectApp(bob.token);
    const momApp = await a.connectApp(mom.token);
    bApp.write({ t: "call.connection", connectionId: bConn });
    const ring = await momApp.next("call.ringing");
    await talk(bApp, momApp, ring.callId).catch(() => {});
    momApp.write({ t: "call.transfer", callId: ring.callId, to: { userId: dad.id } });
    expect((await momApp.next("error")).message).toMatch(/team or org space/);
  });
});
