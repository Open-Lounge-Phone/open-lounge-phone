// Call recording (docs/security-model.md): off by default, never with kids' phones, always
// announced to every party before anyone gets a ticket to record.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, FakeConn, type Msg, Network, TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

async function team(s: TestServer) {
  const olga = await s.person("olga", "Olga", "team");
  const add = async (name: string, role: "guardian" | "contact") => {
    const user = await s.store.createUser(
      { householdId: olga.household.id, name, role },
      s.timers.now,
    );
    return { user, token: await s.store.createSession(user.id, s.timers.now) };
  };
  return { olga, ben: await add("Ben", "contact"), cy: await add("Cy", "contact") };
}

const recordingOn = (s: TestServer, token: string, enabled = true) =>
  s.http("/space/recording", { method: "PUT", token, body: { enabled } });

/** Places and connects a call from `a` to `b` (both apps); returns the call id. */
async function liveCall(a: FakeConn, b: FakeConn, userId: string) {
  a.write({ t: "call.user", userId });
  const ring = await b.next("call.ringing");
  b.write({ t: "call.answer", callId: ring.callId });
  await a.nextState("connecting");
  a.write({ t: "rtc.sdp", callId: ring.callId, type: "offer", sdp: "v=0 o" });
  await b.next("rtc.sdp");
  b.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a" });
  await a.nextState("active");
  await b.nextState("active");
  return ring.callId;
}

type CallState = Extract<Msg, { t: "call.state" }>;
const notices = (c: FakeConn) => c.all("call.state").filter((m) => m.recording) as CallState[];
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("recording in a space", () => {
  let s: TestServer;
  let t: Awaited<ReturnType<typeof team>>;
  beforeEach(async () => {
    FakeConn.journal = [];
    s = new TestServer({ publicUrl: "https://work.test" });
    t = await team(s);
  });

  it("is off by default: a call carries no recording and no ticket", async () => {
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    await liveCall(ben, cy, t.cy.user.id);
    await settle();
    expect([...notices(ben), ...notices(cy)]).toEqual([]);
    expect((await s.http("/space/recording", { token: t.ben.token })).json).toMatchObject({
      enabled: false,
      allowed: true,
    });
  });

  it("only admins turn it on; then every party is told before the recorder gets its ticket", async () => {
    expectStatus(await recordingOn(s, t.ben.token), 403);
    expectStatus(await recordingOn(s, t.olga.token), 204);
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    const callId = await liveCall(ben, cy, t.cy.user.id);
    await vi.waitFor(() => expect(notices(ben).length + notices(cy).length).toBe(2));
    const all = [...notices(ben), ...notices(cy)];
    // Both hear it's recorded, by the team; exactly one of them (on this side) records.
    expect(all.map((m) => m.recording?.by)).toEqual(["Olga's home", "Olga's home"]);
    const withTicket = all.filter((m) => m.recording?.ticket);
    expect(withTicket).toHaveLength(1);
    // The announcement to the other party went out before the ticket.
    const order = FakeConn.journal.filter(
      (j) => j.msg.t === "call.state" && j.msg.callId === callId && j.msg.recording,
    );
    expect(order).toHaveLength(2);
    expect(order[0]?.msg.t === "call.state" && order[0].msg.recording?.ticket).toBeFalsy();
    expect(order[1]?.msg.t === "call.state" && order[1].msg.recording?.ticket).toBeTruthy();
    // The recorder uploads when the call ends; the ticket works once.
    ben.write({ t: "call.hangup", callId });
    await cy.nextState("ended");
    const ticket = withTicket[0]?.recording?.ticket as string;
    const up = (tk: string) =>
      s.http(`/rec/upload?ticket=${tk}&durationMs=5000`, {
        raw: new Uint8Array([1, 2, 3, 4]),
        type: "audio/webm",
      });
    expectStatus(await up("x".repeat(43)), 404);
    const res = await up(ticket);
    expectStatus(res, 201);
    expectStatus(await up(ticket), 404);
    // It lands in the call log (both sides' rows) and the parties' lists, transcribed.
    await Promise.all(s.background);
    const log = (await s.http("/space/calls", { token: t.olga.token })).json;
    expect(log.map((r: { recordingId: string }) => r.recordingId)).toEqual([
      res.json.id,
      res.json.id,
    ]);
    const benList = (await s.http("/recordings", { token: t.ben.token })).json;
    expect(benList).toMatchObject([{ id: res.json.id, transcriptStatus: "done", kind: "call" }]);
    const audio = (token: string) =>
      s.api.request(`/recordings/${res.json.id}/audio`, {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await audio(t.cy.token)).status).toBe(200);
    // Someone who wasn't on the call (and isn't an admin) can't hear it.
    const dee = await s.store.createUser(
      { householdId: t.olga.household.id, name: "Dee", role: "contact" },
      s.timers.now,
    );
    const deeToken = await s.store.createSession(dee.id, s.timers.now);
    expect((await audio(deeToken)).status).toBe(404);
    expect((await s.http("/recordings", { token: deeToken })).json).toEqual([]);
    // Turning it on is in the audit trail.
    const audit = (await s.http("/space/audit", { token: t.olga.token })).json;
    expect(audit.map((e: { action: string }) => e.action)).toContain("recording.update");
  });

  it("isn't transcribed where the space doesn't transcribe, and expires with its history", async () => {
    await recordingOn(s, t.olga.token);
    await s.http("/space/privacy", {
      method: "PUT",
      token: t.olga.token,
      body: { transcription: false, history: "30d" },
    });
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    const callId = await liveCall(ben, cy, t.cy.user.id);
    await vi.waitFor(() => expect(notices(ben).length + notices(cy).length).toBe(2));
    const ticket = [...notices(ben), ...notices(cy)].find((m) => m.recording?.ticket)?.recording
      ?.ticket as string;
    ben.write({ t: "call.hangup", callId });
    await cy.nextState("ended");
    const res = await s.http(`/rec/upload?ticket=${ticket}&durationMs=1000`, {
      raw: new Uint8Array([9]),
      type: "audio/webm",
    });
    expect((await s.store.recordings.get(res.json.id))?.transcriptStatus).toBe("unavailable");
    expect(s.blobs.size).toBe(1);
    s.timers.advance(31 * 24 * 60 * 60 * 1000);
    await s.store.sweepExpired(t.olga.household.id, "work.test", s.timers.now).then(async (r) => {
      for (const k of r.blobs) await s.env.blobs.delete(k);
      expect(r.recordings).toBe(1);
    });
    expect(await s.store.recordings.get(res.json.id)).toBeUndefined();
    expect(s.blobs.size).toBe(0);
  });

  it("never in a home with kids' phones", async () => {
    const mom = await s.person("mom", "Mom");
    expectStatus(await recordingOn(s, mom.token), 204);
    // A home that records can't take a kids' phone…
    const refused = await s.pairDevice(mom.token, "Kid");
    expect(refused.status).toBe(409);
    await recordingOn(s, mom.token, false);
    // …and a home with one can't turn recording on.
    expect((await s.pairDevice(mom.token, "Kid")).status).toBe(201);
    const on = await recordingOn(s, mom.token);
    expectStatus(on, 409);
    expect(on.json.error).toMatch(/kids' phones/);
    expect((await s.http("/space/recording", { token: mom.token })).json).toMatchObject({
      enabled: false,
      allowed: false,
    });
  });

  it("a room is announced to everyone; only one participant records, and a new one takes over", async () => {
    await recordingOn(s, t.olga.token);
    const room = await s.http("/rooms", {
      token: t.olga.token,
      body: { kind: "party", name: "Desk" },
    });
    const ben = await s.connectApp(t.ben.token);
    const cy = await s.connectApp(t.cy.token);
    ben.write({ t: "room.join", roomId: room.json.id });
    const first = await ben.next("room.state");
    expect(first.recording).toMatchObject({ by: "Olga's home" });
    expect(first.recording?.ticket).toBeTruthy();
    cy.write({ t: "room.join", roomId: room.json.id });
    const cyState = await cy.next("room.state");
    expect(cyState.recording).toEqual({ by: "Olga's home" });
    // Ben (recording) leaves: Cy is told and records the rest.
    ben.write({ t: "room.leave", roomId: room.json.id });
    await vi.waitFor(() => expect(cy.all("room.state").at(-1)?.recording?.ticket).toBeTruthy());
    expect(cy.all("room.state").at(-1)?.recording?.ticket).not.toBe(first.recording?.ticket);
  });
});

describe("recording across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let t: Awaited<ReturnType<typeof team>>;
  let bob: Person;
  let bSide: string;
  let aSide: string;
  async function setup(refuse: boolean) {
    FakeConn.journal = [];
    net = new Network();
    a = await net.server("a.test");
    b = await net.server("b.test", { env: { refuseRecordedCalls: refuse } });
    t = await team(a);
    bob = await b.person("bob", "Bob");
    await recordingOn(a, t.olga.token);
    expectStatus(
      await b.http("/connections", { token: bob.token, body: { to: t.olga.address } }),
      202,
    );
    const req = (await a.http("/connections", { token: t.olga.token })).json.connections[0];
    await a.http(`/connections/${req.id}/accept`, { method: "POST", token: t.olga.token });
    aSide = req.id;
    bSide = (await b.http("/connections", { token: bob.token })).json.connections[0].id;
  }

  async function bobCallsOlga() {
    const bApp = await b.connectApp(bob.token);
    const oApp = await a.connectApp(t.olga.token);
    bApp.write({ t: "call.connection", connectionId: bSide });
    const ring = await oApp.next("call.ringing");
    const bCall = (await bApp.nextState("ringing")).callId;
    oApp.write({ t: "call.answer", callId: ring.callId });
    await bApp.nextState("connecting");
    bApp.write({ t: "rtc.sdp", callId: bCall, type: "offer", sdp: "v=0 o" });
    await oApp.next("rtc.sdp");
    oApp.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a" });
    return { bApp, oApp, bCall };
  }

  it("the other server's person is told (from their own server), without a ticket", async () => {
    await setup(false);
    const { bApp, oApp } = await bobCallsOlga();
    await vi.waitFor(() => expect(notices(bApp)).toHaveLength(1));
    expect(notices(bApp)[0]?.recording).toEqual({ by: "Olga's home" });
    // Olga's own app records (she's the only one on the recording side).
    await vi.waitFor(() => expect(notices(oApp)[0]?.recording?.ticket).toBeTruthy());
  });

  it("a server that refuses recorded calls: refused when placed, ended when announced", async () => {
    await setup(true);
    // Olga (recording team) calls Bob: b says no up front.
    const oApp = await a.connectApp(t.olga.token);
    oApp.write({ t: "call.connection", connectionId: aSide });
    const refused = await oApp.nextState("ended");
    expect(refused).toMatchObject({
      reason: "denied",
      note: "This server doesn't take recorded calls",
    });
    // Bob calls Olga: once it's live and announced, b ends it for Bob and says why.
    const { bApp } = await bobCallsOlga();
    const ended = await bApp.nextState("ended");
    expect(ended).toMatchObject({
      reason: "denied",
      note: "This server doesn't take recorded calls",
    });
    expect(notices(bApp)).toEqual([]);
  });

  it("a server without `recording-flag`: never placed, and ended rather than recorded unannounced", async () => {
    await setup(false);
    await net.advertise("b.test", (d) => ({
      ...d,
      features: (d.features as string[]).filter((f) => f !== "recording-flag"),
    }));
    const oApp = await a.connectApp(t.olga.token);
    oApp.write({ t: "call.connection", connectionId: aSide });
    expect(await oApp.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "This call would be recorded, and that server can't announce recordings yet, so it wasn't placed",
    });
    expect(net.requests.filter((r) => r.url.endsWith("/fed/v1/calls"))).toEqual([]);
    // Bob calls Olga: it would be recorded on her side, and his server can't be told: it ends.
    const { bApp, oApp: olga } = await bobCallsOlga();
    expect(await bApp.nextState("ended")).toMatchObject({ reason: "denied" });
    await settle();
    // Nobody was told it's recorded, and Olga's app got no ticket to record it.
    expect(notices(bApp)).toEqual([]);
    expect(notices(olga)).toEqual([]);
  });

  it("a recording space's rooms refuse people whose server can't announce it", async () => {
    await setup(false);
    const room = await a.http("/rooms", {
      token: t.olga.token,
      body: { kind: "phone", name: "Standup", handle: "standup", access: "connections" },
    });
    expectStatus(room, 201);
    await net.advertise("b.test", (d) => ({
      ...d,
      features: (d.features as string[]).filter((f) => f !== "recording-flag"),
    }));
    const bApp = await b.connectApp(bob.token);
    bApp.write({ t: "room.join", address: "standup@a.test" });
    expect(await bApp.next("room.ended")).toMatchObject({
      reason: "denied",
      note: "This space records its calls, and that server can't announce recordings yet",
    });
  });

  it("a kids' phone on the other server is never recorded", async () => {
    await setup(false);
    const paired = await b.pairDevice(bob.token, "Kid");
    if (!paired.deviceId || !paired.key) throw new Error("pairing failed");
    const rc = await b.http(`/devices/${paired.deviceId}/remote-contacts/${bSide}`, {
      method: "PUT",
      token: bob.token,
      body: { label: "Olga", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
    });
    await b.http(`/devices/${paired.deviceId}/buttons/1`, {
      method: "PUT",
      token: bob.token,
      body: { userId: rc.json.id },
    });
    const kid = await b.connectDevice(paired.deviceId, paired.key.pair);
    const oApp = await a.connectApp(t.olga.token);
    kid.write({ t: "hook", state: "up" });
    kid.write({ t: "button", index: 1 });
    const ring = await oApp.next("call.ringing");
    const kCall = (await kid.nextState("ringing")).callId;
    oApp.write({ t: "call.answer", callId: ring.callId });
    await kid.nextState("connecting");
    kid.write({ t: "rtc.sdp", callId: kCall, type: "offer", sdp: "v=0 o" });
    await oApp.next("rtc.sdp");
    oApp.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 a" });
    await oApp.nextState("active");
    await kid.nextState("active");
    await settle();
    expect([...notices(oApp), ...notices(kid)]).toEqual([]);
  });
});
