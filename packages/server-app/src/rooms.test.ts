import { ROOM_IDLE_GRACE_MS, ROOM_IDLE_MS } from "@openloungephone/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEnv } from "./env.ts";
import { expectStatus, type FakeConn, Network, TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

const SDP_OFFER = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=sendonly\r\n";

/** A space with a guardian (Mom), a second grown-up (Dad) and their sessions. */
async function family(s: TestServer) {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "contact" },
    s.timers.now,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  return { mom, dad, dadToken };
}

async function makeRoom(
  s: TestServer,
  token: string,
  body: { kind: "party" | "phone"; name: string; handle?: string; access?: string },
) {
  const r = await s.http("/rooms", { token, body });
  expectStatus(r, 201);
  return r.json as { id: string; address?: string };
}

/** Pairs and connects a kids' phone; returns it with its id. */
async function kidsPhone(s: TestServer, token: string) {
  const paired = await s.pairDevice(token, "Kid");
  if (paired.status !== 201 || !paired.deviceId || !paired.key) throw new Error("pairing failed");
  const phone = await s.connectDevice(paired.deviceId, paired.key.pair);
  return { phone, deviceId: paired.deviceId };
}

/** Lets queued socket messages be handled. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function joined(conn: FakeConn) {
  return conn.next("room.state");
}

describe("rooms in a space (no relay: peer-to-peer mesh)", () => {
  let s: TestServer;
  let fam: Awaited<ReturnType<typeof family>>;
  beforeEach(async () => {
    s = new TestServer({ publicUrl: "https://home.test" });
    fam = await family(s);
  });

  it("a party line: members drop in, see who's in, and mesh audio is relayed peer to peer", async () => {
    const line = await makeRoom(s, fam.mom.token, { kind: "party", name: "Kitchen" });
    const mom = await s.connectApp(fam.mom.token);
    const dad = await s.connectApp(fam.dadToken);
    mom.write({ t: "room.join", roomId: line.id });
    const first = await joined(mom);
    expect(first).toMatchObject({
      kind: "party",
      name: "Kitchen",
      media: "mesh",
      e2ee: true,
      participants: [{ name: "Mom", host: true, muted: false }],
    });
    // ICE servers come first, so the client can start its audio when the room arrives.
    expect(mom.all("rtc.config").at(-1)?.callId).toBe(line.id);
    // Dad (not in the room) sees who's in.
    expect(await dad.next("rooms.changed")).toEqual({
      t: "rooms.changed",
      roomId: line.id,
      people: ["Mom"],
    });
    expect((await s.http("/rooms", { token: fam.dadToken })).json.rooms[0]).toMatchObject({
      id: line.id,
      people: ["Mom"],
      mine: false,
    });
    dad.write({ t: "room.join", roomId: line.id });
    const both = await joined(dad);
    expect(both.participants.map((p) => p.name)).toEqual(["Mom", "Dad"]);
    const momSees = await joined(mom);
    expect(momSees.participants).toHaveLength(2);
    // Mesh: an offer from Mom to Dad arrives as from Mom.
    mom.write({ t: "rtc.sdp", callId: line.id, type: "offer", sdp: "v=0 o", peer: both.you });
    expect(await dad.next("rtc.sdp")).toMatchObject({ peer: first.you, sdp: "v=0 o" });
    // Leaving tells the others.
    dad.write({ t: "room.leave", roomId: line.id });
    expect(await dad.next("room.ended")).toMatchObject({ roomId: line.id, reason: "left" });
    expect((await joined(mom)).participants).toHaveLength(1);
  });

  it("a mesh room holds 4; the fifth is told it's full", async () => {
    const room = await makeRoom(s, fam.mom.token, { kind: "party", name: "Big" });
    const conns: FakeConn[] = [];
    for (let i = 0; i < 4; i++) {
      const u = await s.store.createUser(
        { householdId: fam.mom.household.id, name: `P${i}`, role: "contact" },
        s.timers.now,
      );
      const c = await s.connectApp(await s.store.createSession(u.id, s.timers.now));
      c.write({ t: "room.join", roomId: room.id });
      await joined(c);
      conns.push(c);
    }
    const mom = await s.connectApp(fam.mom.token);
    mom.write({ t: "room.join", roomId: room.id });
    expect(await mom.next("room.ended")).toMatchObject({ reason: "full" });
  });

  it("the host locks, removes and mutes; others can't", async () => {
    const room = await makeRoom(s, fam.dadToken, {
      kind: "phone",
      name: "Standup",
      handle: "standup",
    });
    const dad = await s.connectApp(fam.dadToken);
    const mom = await s.connectApp(fam.mom.token);
    dad.write({ t: "room.join", roomId: room.id });
    const d = await joined(dad);
    expect(d.participants[0]).toMatchObject({ name: "Dad", host: true });
    expect(d.address).toBe("standup@home.test");
    mom.write({ t: "room.join", roomId: room.id });
    const m = await joined(mom);
    // Mom is a guardian of the home: she may host too. A plain member may not.
    const kid = await s.store.createUser(
      { householdId: fam.mom.household.id, name: "Teen", role: "contact" },
      s.timers.now,
    );
    const teen = await s.connectApp(await s.store.createSession(kid.id, s.timers.now));
    teen.write({ t: "room.join", roomId: room.id });
    const t = await joined(teen);
    expect(t.participants.find((p) => p.id === t.you)?.host).toBeUndefined();
    teen.write({ t: "room.lock", roomId: room.id, locked: true });
    expect((await teen.next("error")).message).toMatch(/host/);
    teen.write({ t: "room.mute", roomId: room.id, muted: true, participant: m.you });
    expect((await teen.next("error")).message).toMatch(/host/);
    teen.write({ t: "room.remove", roomId: room.id, participant: m.you });
    expect((await teen.next("error")).message).toMatch(/host/);
    // The host mutes the teen (who may unmute), removes them, and locks the room.
    dad.write({ t: "room.mute", roomId: room.id, muted: true, participant: t.you });
    await vi.waitFor(() =>
      expect(
        teen
          .all("room.state")
          .at(-1)
          ?.participants.find((p) => p.id === t.you)?.muted,
      ).toBe(true),
    );
    dad.write({ t: "room.remove", roomId: room.id, participant: t.you });
    expect(await teen.next("room.ended")).toMatchObject({ reason: "removed" });
    dad.write({ t: "room.lock", roomId: room.id, locked: true });
    await vi.waitFor(async () => expect((await s.store.rooms.get(room.id))?.locked).toBe(true));
    teen.write({ t: "room.join", roomId: room.id });
    expect(await teen.next("room.ended")).toMatchObject({ reason: "locked" });
  });

  it("a kids' phone joins only a room of its space that a guardian put on its list", async () => {
    const line = await makeRoom(s, fam.mom.token, { kind: "party", name: "Cousins" });
    const { phone, deviceId } = await kidsPhone(s, fam.mom.token);
    // Not on its list: a key can't even point at it.
    expectStatus(
      await s.http(`/devices/${deviceId}/buttons/1`, {
        method: "PUT",
        token: fam.mom.token,
        body: { userId: "rk_nope" },
      }),
      400,
    );
    // A member who isn't a guardian can't put it there either.
    expectStatus(
      await s.http(`/devices/${deviceId}/rooms/${line.id}`, {
        method: "PUT",
        token: fam.dadToken,
        body: { label: "Cousins" },
      }),
      404,
    );
    const put = await s.http(`/devices/${deviceId}/rooms/${line.id}`, {
      method: "PUT",
      token: fam.mom.token,
      body: { label: "Cousins" },
    });
    expectStatus(put, 200);
    expectStatus(
      await s.http(`/devices/${deviceId}/buttons/1`, {
        method: "PUT",
        token: fam.mom.token,
        body: { userId: put.json.id },
      }),
      204,
    );
    const cfg = await vi.waitFor(() => {
      const c = phone.all("config").at(-1);
      if (!c?.buttons.some((b) => b.label === "Cousins")) throw new Error("not yet");
      return c;
    });
    expect(cfg.buttons).toContainEqual({ index: 1, label: "Cousins" });
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 1 });
    expect(await joined(phone)).toMatchObject({ roomId: line.id, kind: "party" });
    phone.write({ t: "room.leave", roomId: line.id });
    await phone.next("room.ended");
    // Taken off the list: the phone can't get in any more (and its key is gone).
    expectStatus(
      await s.http(`/devices/${deviceId}/rooms/${put.json.id}`, {
        method: "DELETE",
        token: fam.mom.token,
      }),
      204,
    );
    phone.write({ t: "button", index: 1 });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    // A room of another space can't be put on it.
    const other = await s.person("neighbor", "Neighbor");
    const theirs = await makeRoom(s, other.token, { kind: "party", name: "Theirs" });
    expectStatus(
      await s.http(`/devices/${deviceId}/rooms/${theirs.id}`, {
        method: "PUT",
        token: fam.mom.token,
        body: { label: "Theirs" },
      }),
      404,
    );
  });

  it("nobody from another space gets in by id", async () => {
    const line = await makeRoom(s, fam.mom.token, { kind: "party", name: "Ours" });
    const other = await s.person("neighbor", "Neighbor");
    const app = await s.connectApp(other.token);
    app.write({ t: "room.join", roomId: line.id });
    expect(await app.next("room.ended")).toMatchObject({ reason: "denied" });
  });

  it("drops someone after 10 silent minutes, with a warning a minute before", async () => {
    const line = await makeRoom(s, fam.mom.token, { kind: "party", name: "Line" });
    const mom = await s.connectApp(fam.mom.token);
    const dad = await s.connectApp(fam.dadToken);
    mom.write({ t: "room.join", roomId: line.id });
    await joined(mom);
    dad.write({ t: "room.join", roomId: line.id });
    const d = await joined(dad);
    // Dad talks now and then; Mom says nothing.
    s.timers.advance(ROOM_IDLE_MS / 2);
    dad.write({ t: "room.talk", roomId: line.id, speaking: true });
    dad.write({ t: "room.talk", roomId: line.id, speaking: false });
    await settle(); // handled before the clock moves on
    s.timers.advance(ROOM_IDLE_MS / 2);
    const warn = await mom.next("room.idle");
    expect(warn.dropAt).toBe(s.timers.now + ROOM_IDLE_GRACE_MS);
    expect(dad.all("room.idle")).toEqual([]);
    s.timers.advance(ROOM_IDLE_GRACE_MS);
    expect(await mom.next("room.ended")).toMatchObject({ reason: "idle" });
    // Dad answers his own warning in time and stays.
    s.timers.advance(ROOM_IDLE_MS / 2);
    await vi.waitFor(() => {
      s.timers.advance(0); // the hub re-arms its alarm asynchronously
      expect(dad.all("room.idle")).toHaveLength(1);
    });
    dad.write({ t: "room.here", roomId: line.id });
    await s.gateway.hub(fam.mom.household.id).roomPeople();
    s.timers.advance(ROOM_IDLE_GRACE_MS);
    expect(dad.all("room.ended")).toEqual([]);
    expect(await s.gateway.hub(fam.mom.household.id).roomPeople()).toEqual({ [line.id]: ["Dad"] });
    expect(d.you).toBeTruthy();
  });

  it("meters room minutes for fair use and refuses a join over the allowance", async () => {
    s = new TestServer({
      publicUrl: "https://home.test",
      env: { fairUse: { roomMinutesPerMonth: 10 } },
    });
    fam = await family(s);
    const line = await makeRoom(s, fam.mom.token, { kind: "party", name: "Line" });
    const mom = await s.connectApp(fam.mom.token);
    mom.write({ t: "room.join", roomId: line.id });
    await joined(mom);
    s.timers.advance(9 * 60_000 + 1);
    mom.write({ t: "room.talk", roomId: line.id, speaking: true });
    mom.write({ t: "room.leave", roomId: line.id });
    await mom.next("room.ended");
    await vi.waitFor(async () =>
      expect((await s.store.usage(fam.mom.account.id, s.timers.now)).roomMinutes).toBe(10),
    );
    mom.write({ t: "room.join", roomId: line.id });
    const refused = await mom.next("room.ended");
    expect(refused).toMatchObject({ reason: "denied" });
    expect(refused.note).toMatch(/room minutes/);
  });

  it("room addresses share the handle namespace with people", async () => {
    const taken = await s.http("/rooms", {
      token: fam.mom.token,
      body: { kind: "phone", name: "Mom?", handle: "mom" },
    });
    expectStatus(taken, 409);
    await makeRoom(s, fam.mom.token, { kind: "phone", name: "Book club", handle: "bookclub" });
    expect(await s.store.handleAvailable("bookclub", s.timers.now)).toBe(false);
    expect(await s.store.setHandle(fam.mom.account.id, "bookclub", s.timers.now)).toBe(false);
    // Only guardians make party lines.
    expectStatus(
      await s.http("/rooms", { token: fam.dadToken, body: { kind: "party", name: "Mine" } }),
      403,
    );
  });
});

describe("hold, 3-way calls and transfer", () => {
  let s: TestServer;
  let fam: Awaited<ReturnType<typeof family>>;
  let gran: { id: string; token: string };
  beforeEach(async () => {
    s = new TestServer({ publicUrl: "https://home.test" });
    fam = await family(s);
    const g = await s.store.createUser(
      { householdId: fam.mom.household.id, name: "Gran", role: "contact" },
      s.timers.now,
    );
    gran = { id: g.id, token: await s.store.createSession(g.id, s.timers.now) };
  });

  /** `caller` calls `userId` (whose app is `callee`) and they talk. */
  async function call(caller: FakeConn, callee: FakeConn, userId: string) {
    caller.write({ t: "call.user", userId });
    const { callId } = await callee.next("call.ringing");
    callee.write({ t: "call.answer", callId });
    await caller.nextState("connecting");
    caller.write({ t: "rtc.sdp", callId, type: "offer", sdp: "o" });
    await callee.next("rtc.sdp");
    callee.write({ t: "rtc.sdp", callId, type: "answer", sdp: "a" });
    await caller.nextState("active");
    await callee.nextState("active");
    return callId;
  }

  it("holds, consults, and merges into a room with no one dropped", async () => {
    const mom = await s.connectApp(fam.mom.token);
    const dad = await s.connectApp(fam.dadToken);
    const g = await s.connectApp(gran.token);
    const first = await call(mom, dad, fam.dad.id);
    // A second call without holding the first: refused.
    mom.write({ t: "call.user", userId: gran.id });
    expect(await mom.nextState("ended")).toMatchObject({ reason: "busy" });
    mom.write({ t: "call.hold", callId: first, hold: true });
    expect(await mom.nextState("active")).toMatchObject({ callId: first, hold: "you" });
    expect(await dad.nextState("active")).toMatchObject({ callId: first, hold: "them" });
    // Dad can't hold a call he's being held on.
    dad.write({ t: "call.hold", callId: first, hold: true });
    expect((await dad.next("error")).message).toMatch(/hold/);
    const second = await call(mom, g, gran.id);
    mom.write({ t: "call.merge", callId: first, with: second });
    const ends = [await mom.nextState("ended"), await mom.nextState("ended")];
    const roomId = ends[0]?.merged?.roomId as string;
    expect(ends.map((e) => e.merged?.roomId)).toEqual([roomId, roomId]);
    expect(await dad.nextState("ended")).toMatchObject({ merged: { roomId } });
    expect(await g.nextState("ended")).toMatchObject({ merged: { roomId } });
    for (const c of [mom, dad, g]) {
      const st = await vi.waitFor(() => {
        const last = c.all("room.state").at(-1);
        if (last?.participants.length !== 3) throw new Error("not all in yet");
        return last;
      });
      expect(st).toMatchObject({ roomId, kind: "call", media: "mesh" });
    }
    expect(
      mom
        .all("room.state")
        .at(-1)
        ?.participants.find((p) => p.name === "Mom")?.host,
    ).toBe(true);
    // Two leave: the 3-way call closes for the last one.
    dad.write({ t: "room.leave", roomId });
    g.write({ t: "room.leave", roomId });
    expect(await mom.next("room.ended")).toMatchObject({ roomId, reason: "closed" });
    // Each call was logged as usual.
    const log = await s.store.callLog(fam.mom.account.id, `user:${fam.dad.id}`);
    expect(log).toHaveLength(1);
  });

  it("never merges a kids' phone with someone who isn't on its list", async () => {
    const { phone, deviceId } = await kidsPhone(s, fam.mom.token);
    for (const [id, label] of [[fam.mom.user.id, "Mom"]] as const) {
      await s.http(`/devices/${deviceId}/contacts/${id}`, {
        method: "PUT",
        token: fam.mom.token,
        body: { label, canCallDevice: true, deviceCanCall: true, bypassQuietHours: true },
      });
    }
    const mom = await s.connectApp(fam.mom.token);
    const g = await s.connectApp(gran.token);
    mom.write({ t: "call.dial", deviceId });
    const { callId: kidCall } = await phone.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.answer", callId: kidCall });
    await mom.nextState("connecting");
    mom.write({ t: "rtc.sdp", callId: kidCall, type: "offer", sdp: "o" });
    phone.write({ t: "rtc.sdp", callId: kidCall, type: "answer", sdp: "a" });
    await mom.nextState("active");
    mom.write({ t: "call.hold", callId: kidCall, hold: true });
    await mom.nextState("active");
    const second = await call(mom, g, gran.id);
    mom.write({ t: "call.merge", callId: kidCall, with: second });
    expect((await mom.next("error")).message).toMatch(/kids' phone/);
    // Both calls go on.
    expect(mom.all("call.state").some((m) => m.state === "ended")).toBe(false);
  });

  it("blind transfer: the other person rings the target as themselves", async () => {
    const mom = await s.connectApp(fam.mom.token);
    const dad = await s.connectApp(fam.dadToken);
    const g = await s.connectApp(gran.token);
    const callId = await call(dad, mom, fam.mom.user.id);
    mom.write({ t: "call.transfer", callId, to: { userId: gran.id } });
    expect(await mom.nextState("ended")).toMatchObject({ callId, reason: "hangup" });
    const moved = await dad.nextState("ended");
    expect(moved.transfer).toMatchObject({ ringing: true, offerer: true });
    const ring = await g.next("call.ringing");
    expect(ring).toMatchObject({ callId: moved.transfer?.callId, from: { label: "Dad" } });
    expect(await dad.nextState("ringing")).toMatchObject({ callId: moved.transfer?.callId });
    g.write({ t: "call.answer", callId: ring.callId });
    expect(await dad.nextState("connecting")).toMatchObject({ callId: ring.callId });
  });

  it("refuses a blind transfer the person couldn't make themselves (a kids' phone)", async () => {
    const { phone, deviceId } = await kidsPhone(s, fam.mom.token);
    await s.http(`/devices/${deviceId}/contacts/${fam.mom.user.id}`, {
      method: "PUT",
      token: fam.mom.token,
      body: { label: "Mom", canCallDevice: true, deviceCanCall: true, bypassQuietHours: true },
    });
    const mom = await s.connectApp(fam.mom.token);
    await s.connectApp(gran.token);
    mom.write({ t: "call.dial", deviceId });
    const { callId } = await phone.next("call.ringing");
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "call.answer", callId });
    await mom.nextState("connecting");
    mom.write({ t: "rtc.sdp", callId, type: "answer", sdp: "a" });
    phone.write({ t: "rtc.sdp", callId, type: "answer", sdp: "a" });
    await mom.nextState("active");
    mom.write({ t: "call.transfer", callId, to: { userId: gran.id } });
    expect((await mom.next("error")).message).toMatch(/transfer refused/);
    // The call is still on: nobody was told it ended.
    expect(phone.all("call.state").filter((m) => m.state === "ended")).toEqual([]);
    mom.write({ t: "call.hangup", callId });
    expect(await phone.nextState("ended")).toMatchObject({ callId, reason: "hangup" });
  });

  it("attended transfer connects the two others, the held one offering", async () => {
    const mom = await s.connectApp(fam.mom.token);
    const dad = await s.connectApp(fam.dadToken);
    const g = await s.connectApp(gran.token);
    const first = await call(mom, dad, fam.dad.id);
    mom.write({ t: "call.hold", callId: first, hold: true });
    await mom.nextState("active");
    const second = await call(mom, g, gran.id);
    mom.write({ t: "call.transfer", callId: first, toCall: second });
    const d = await dad.nextState("ended");
    const gg = await g.nextState("ended");
    expect(d.transfer).toMatchObject({ ringing: false, offerer: true });
    expect(gg.transfer).toMatchObject({
      callId: d.transfer?.callId,
      ringing: false,
      offerer: false,
    });
    const newId = d.transfer?.callId as string;
    expect(await dad.next("rtc.config")).toMatchObject({ callId: newId });
    expect(await dad.nextState("connecting")).toMatchObject({ callId: newId });
    expect(await g.nextState("connecting")).toMatchObject({ callId: newId });
    await mom.nextState("ended");
    await mom.nextState("ended");
    dad.write({ t: "rtc.sdp", callId: newId, type: "offer", sdp: "o" });
    expect(await g.next("rtc.sdp")).toMatchObject({ callId: newId, type: "offer" });
  });
});

describe("rooms across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test", {
      env: { iceServers: async () => [{ urls: "turn:turn.a.test" }] },
    });
    b = await net.server("b.test", {
      env: { iceServers: async () => [{ urls: "turn:turn.b.test" }] },
    });
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
  });

  async function connectPeople() {
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
    const mine = (await a.http("/connections", { token: jesse.token })).json.connections.find(
      (c: { address: string }) => c.address === bob.address,
    );
    return mine.id as string;
  }

  it("joins a phone room on another server by address, only with a connection to its owner", async () => {
    const room = await makeRoom(a, jesse.token, {
      kind: "phone",
      name: "Standup",
      handle: "standup",
      access: "connections",
    });
    expect(room.address).toBe("standup@a.test");
    const bApp = await b.connectApp(bob.token);
    bApp.write({ t: "room.join", address: "standup@a.test" });
    expect(await bApp.next("room.ended")).toMatchObject({ reason: "denied" });
    await connectPeople();
    const jApp = await a.connectApp(jesse.token);
    jApp.write({ t: "room.join", roomId: room.id });
    const j = await joined(jApp);
    bApp.write({ t: "room.join", address: "standup@a.test" });
    const bs = await joined(bApp);
    expect(bs).toMatchObject({ roomId: room.id, address: "standup@a.test" });
    expect(bs.participants.map((p) => p.name)).toEqual(["Jesse", "Bob"]);
    // Bob's own server hands him its own TURN.
    expect(bApp.all("rtc.config").at(-1)).toMatchObject({
      callId: room.id,
      iceServers: [{ urls: "turn:turn.b.test" }],
    });
    const jSees = await joined(jApp);
    expect(jSees.participants.find((p) => p.name === "Bob")?.remote).toBe("b.test");
    // Mesh signaling crosses the servers.
    jApp.write({ t: "rtc.sdp", callId: room.id, type: "offer", sdp: "o", peer: bs.you });
    expect(await bApp.next("rtc.sdp")).toMatchObject({ peer: j.you, sdp: "o" });
    bApp.write({ t: "rtc.sdp", callId: room.id, type: "answer", sdp: "a", peer: j.you });
    expect(await jApp.next("rtc.sdp")).toMatchObject({ peer: bs.you, sdp: "a" });
    // The host removes Bob; his server tells him.
    jApp.write({ t: "room.remove", roomId: room.id, participant: bs.you });
    expect(await bApp.next("room.ended")).toMatchObject({ roomId: room.id, reason: "removed" });
    await vi.waitFor(async () =>
      expect((await b.store.usage(bob.account.id, net.timers.now)).roomMinutes).toBe(1),
    );
  });

  it("a room only for its space refuses connections from other servers", async () => {
    await makeRoom(a, jesse.token, { kind: "phone", name: "Private", handle: "private" });
    await connectPeople();
    const bApp = await b.connectApp(bob.token);
    bApp.write({ t: "room.join", address: "private@a.test" });
    expect(await bApp.next("room.ended")).toMatchObject({ reason: "denied" });
  });

  it("merges a call with someone on another server into a 3-way room", async () => {
    const connId = await connectPeople();
    const amy = await a.store.createUser(
      { householdId: jesse.household.id, name: "Amy", role: "contact" },
      net.timers.now,
    );
    const amyApp = await a.connectApp(await a.store.createSession(amy.id, net.timers.now));
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: connId });
    const ring = await bApp.next("call.ringing");
    bApp.write({ t: "call.answer", callId: ring.callId });
    await jApp.nextState("connecting");
    jApp.write({ t: "rtc.sdp", callId: ring.callId, type: "offer", sdp: "o" });
    await bApp.next("rtc.sdp");
    bApp.write({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "a" });
    await jApp.nextState("active");
    jApp.write({ t: "call.hold", callId: ring.callId, hold: true });
    await vi.waitFor(() =>
      expect(bApp.all("call.state").some((m) => m.hold === "them")).toBe(true),
    );
    jApp.write({ t: "call.user", userId: amy.id });
    const r2 = await amyApp.next("call.ringing");
    amyApp.write({ t: "call.answer", callId: r2.callId });
    await jApp.nextState("connecting");
    jApp.write({ t: "rtc.sdp", callId: r2.callId, type: "offer", sdp: "o" });
    amyApp.write({ t: "rtc.sdp", callId: r2.callId, type: "answer", sdp: "a" });
    await vi.waitFor(() =>
      expect(
        jApp.all("call.state").some((m) => m.callId === r2.callId && m.state === "active"),
      ).toBe(true),
    );
    jApp.write({ t: "call.merge", callId: ring.callId, with: r2.callId });
    const bobEnd = await bApp.nextState("ended");
    const roomId = bobEnd.merged?.roomId as string;
    expect(roomId).toBeTruthy();
    // Bob is in the room on server a, through his own server.
    const bs = await vi.waitFor(() => {
      const last = bApp.all("room.state").at(-1);
      if (last?.participants.length !== 3) throw new Error("not yet");
      return last;
    });
    expect(bs).toMatchObject({ roomId, kind: "call" });
    expect(bApp.all("rtc.config").at(-1)).toMatchObject({
      callId: roomId,
      iceServers: [{ urls: "turn:turn.b.test" }],
    });
    // Bob leaves; Jesse and Amy stay.
    bApp.write({ t: "room.leave", roomId });
    await bApp.next("room.ended");
    await vi.waitFor(() =>
      expect(
        jApp
          .all("room.state")
          .at(-1)
          ?.participants.map((p) => p.name),
      ).toEqual(["Jesse", "Amy"]),
    );
  });
});

describe("the relay (Cloudflare Realtime SFU, faked)", () => {
  /** A fake SFU: records calls, answers like the real one. */
  function fakeSfu() {
    const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
    let sessions = 0;
    const mids = new Map<string, number>();
    const fetch = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/v1\/apps\/app1/, "");
      const body =
        req.method === "GET"
          ? {}
          : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
      calls.push({ method: req.method, path, body });
      if (path === "/sessions/new") return Response.json({ sessionId: `S${++sessions}` });
      const session = /\/sessions\/([^/]+)/.exec(path)?.[1] as string;
      if (path.endsWith("/tracks/new")) {
        const tracks = body.tracks as { location: string; mid?: string }[];
        if (tracks[0]?.location === "local") {
          return Response.json({
            sessionDescription: { type: "answer", sdp: `answer-${session}` },
            tracks: tracks.map((t) => ({ mid: t.mid })),
          });
        }
        const out = tracks.map(() => {
          const n = (mids.get(session) ?? 0) + 1;
          mids.set(session, n);
          return { mid: String(n) };
        });
        return Response.json({
          requiresImmediateRenegotiation: true,
          sessionDescription: { type: "offer", sdp: `pull-offer-${session}` },
          tracks: out,
        });
      }
      if (path.endsWith("/renegotiate")) return Response.json({});
      if (path.endsWith("/tracks/close")) {
        return Response.json(
          body.sessionDescription
            ? { sessionDescription: { type: "answer", sdp: "close-answer" } }
            : {},
        );
      }
      return Response.json({ errorCode: "not_found" }, { status: 404 });
    };
    return { calls, fetch };
  }

  /** An app that answers the relay's questions like a browser would. */
  function autoClient(conn: FakeConn) {
    const send = conn.send.bind(conn);
    conn.send = (msg) => {
      send(msg);
      if (msg.t !== "room.media") return;
      const roomId = msg.roomId;
      if (msg.type === "offer") {
        queueMicrotask(() =>
          conn.write({ t: "room.media", roomId, type: "answer", sdp: "client-answer" }),
        );
      } else if (msg.type === "close") {
        queueMicrotask(() =>
          conn.write({ t: "room.media", roomId, type: "offer", sdp: SDP_OFFER }),
        );
      }
    };
    return conn;
  }

  it("pushes each microphone, forwards everyone in small rooms and the top 3 above 4", async () => {
    const sfu = fakeSfu();
    const env: Partial<ServerEnv> = {
      relay: {
        kind: "cloudflare",
        appId: "app1",
        appSecret: "secret",
        baseUrl: "https://sfu.test/v1",
      },
      fetch: sfu.fetch,
    };
    const s = new TestServer({ publicUrl: "https://home.test", env });
    const mom = await s.person("mom", "Mom");
    const room = await makeRoom(s, mom.token, { kind: "party", name: "Big room" });
    const people: { conn: FakeConn; you: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await s.store.createUser(
        { householdId: mom.household.id, name: `P${i}`, role: "contact" },
        s.timers.now,
      );
      const conn = autoClient(await s.connectApp(await s.store.createSession(u.id, s.timers.now)));
      conn.write({ t: "room.join", roomId: room.id });
      const st = await joined(conn);
      expect(st).toMatchObject({ media: "sfu", e2ee: false });
      conn.write({ t: "room.media", roomId: room.id, type: "offer", sdp: SDP_OFFER });
      expect(await conn.next("room.media")).toMatchObject({ type: "answer" });
      people.push({ conn, you: st.you });
    }
    // The secret stays on the server: only it talks to the SFU, with its bearer token.
    expect(sfu.calls.filter((c) => c.path === "/sessions/new")).toHaveLength(5);
    // With 5 in the room, each gets exactly 3 others' audio.
    await vi.waitFor(() => {
      for (const p of people) {
        const last = p.conn.all("room.state").at(-1);
        expect(last?.forward).toHaveLength(3);
        expect(last?.forward).not.toContain(p.you);
      }
    });
    const first = people[0] as { conn: FakeConn; you: string };
    const quiet = people[4] as { conn: FakeConn; you: string };
    const before = first.conn.all("room.state").at(-1)?.forward ?? [];
    // Someone not forwarded to P0 starts speaking: P0's relay swaps them in.
    const missing = people.find((p) => p !== first && !before.includes(p.you));
    expect(missing).toBeDefined();
    missing?.conn.write({ t: "room.talk", roomId: room.id, speaking: true });
    await vi.waitFor(() => {
      expect(first.conn.all("room.state").at(-1)?.forward).toContain(missing?.you);
    });
    // The swap was a negotiated close (the client stopped the slot) and a new pull.
    await vi.waitFor(() => {
      expect(first.conn.all("room.media").some((m) => m.type === "close")).toBe(true);
      expect(
        sfu.calls.some((c) => c.path.endsWith("/tracks/close") && c.body.force === false),
      ).toBe(true);
    });
    // A removed participant's session is closed by force: they hear nothing more.
    const host = await s.connectApp(mom.token);
    host.write({ t: "room.join", roomId: room.id });
    await joined(host);
    host.write({ t: "room.remove", roomId: room.id, participant: quiet.you });
    await quiet.conn.next("room.ended");
    await vi.waitFor(() =>
      expect(
        sfu.calls.some(
          (c) => c.path.startsWith("/sessions/S5/tracks/close") && c.body.force === true,
        ),
      ).toBe(true),
    );
  });

  it("stops forwarding a muted participant", async () => {
    const sfu = fakeSfu();
    const s = new TestServer({
      publicUrl: "https://home.test",
      env: {
        relay: {
          kind: "cloudflare",
          appId: "app1",
          appSecret: "s",
          baseUrl: "https://sfu.test/v1",
        },
        fetch: sfu.fetch,
      },
    });
    const mom = await s.person("mom", "Mom");
    const room = await makeRoom(s, mom.token, { kind: "party", name: "Two" });
    const dad = await s.store.createUser(
      { householdId: mom.household.id, name: "Dad", role: "contact" },
      s.timers.now,
    );
    const m = autoClient(await s.connectApp(mom.token));
    const d = autoClient(await s.connectApp(await s.store.createSession(dad.id, s.timers.now)));
    for (const c of [m, d]) {
      c.write({ t: "room.join", roomId: room.id });
      await joined(c);
      c.write({ t: "room.media", roomId: room.id, type: "offer", sdp: SDP_OFFER });
    }
    const dYou = (d.all("room.state").at(-1) as { you: string }).you;
    await vi.waitFor(() => expect(m.all("room.state").at(-1)?.forward).toEqual([dYou]));
    d.write({ t: "room.mute", roomId: room.id, muted: true });
    await vi.waitFor(() => expect(m.all("room.state").at(-1)?.forward).toEqual([]));
    await vi.waitFor(() => expect(m.all("room.media").some((x) => x.type === "close")).toBe(true));
  });
});
