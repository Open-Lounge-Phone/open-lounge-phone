// The buddy timeline (P2b): per-connection history of calls and voicemails, and its expiry.
import { DAY_MS } from "@openloungephone/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, type FakeConn, Network, type TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;
const AUDIO = new Uint8Array(700).fill(9);

/** `a` knocks on `b`, `b` accepts; returns both sides' connection ids. */
async function connect(s: TestServer, a: Person, b: Person) {
  expectStatus(await s.http("/connections", { token: a.token, body: { to: b.address } }), 202);
  const inbox = await s.http("/connections", { token: b.token });
  const req = inbox.json.connections.find((c: { address: string }) => c.address === a.address);
  expectStatus(
    await s.http(`/connections/${req.id}/accept`, { method: "POST", token: b.token }),
    200,
  );
  const mine = (await s.http("/connections", { token: a.token })).json.connections.find(
    (c: { address: string }) => c.address === b.address,
  );
  return { aSide: mine.id as string, bSide: req.id as string };
}

/** `caller` calls `callee` over their connection; answered for `minutes`, or declined. */
async function call(
  caller: FakeConn,
  callee: FakeConn,
  connectionId: string,
  s: TestServer,
  minutes?: number,
) {
  caller.write({ t: "call.connection", connectionId });
  const { callId } = await callee.next("call.ringing");
  const outId = (await caller.nextState("ringing")).callId;
  if (minutes === undefined) {
    callee.write({ t: "call.hangup", callId });
    return caller.nextState("ended");
  }
  callee.write({ t: "call.answer", callId });
  await caller.nextState("connecting");
  caller.write({ t: "rtc.sdp", callId: outId, type: "offer", sdp: "v=0" });
  await callee.next("rtc.sdp");
  callee.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0" });
  await caller.nextState("active");
  s.timers.advance(minutes * 60_000);
  caller.write({ t: "call.hangup", callId: outId });
  await callee.nextState("ended");
  return caller.nextState("ended");
}

let net: Network;
let s: TestServer;
let jesse: Person;
let bob: Person;
let ids: { aSide: string; bSide: string };
let jApp: FakeConn;
let bApp: FakeConn;

beforeEach(async () => {
  net = new Network();
  s = await net.server("home.test");
  jesse = await s.person("jesse", "Jesse");
  bob = await s.person("bob", "Bob");
  ids = await connect(s, jesse, bob);
  jApp = await s.connectApp(jesse.token);
  bApp = await s.connectApp(bob.token);
});

const timeline = (token: string, id: string) => s.http(`/connections/${id}/timeline`, { token });

/** Jesse calls Bob twice: a 3-minute call, then a declined one where Jesse leaves a message. */
async function history() {
  await call(jApp, bApp, ids.aSide, s, 3);
  s.timers.advance(60_000);
  const missed = await call(jApp, bApp, ids.aSide, s);
  const ticket = missed.voicemail?.ticket as string;
  expectStatus(
    await s.http(`/vm/message?ticket=${encodeURIComponent(ticket)}&durationMs=4000`, {
      raw: AUDIO,
      type: "audio/webm",
    }),
    201,
  );
  await Promise.all(s.background);
}

describe("the buddy timeline", () => {
  it("shows each side its calls, and the callee the voicemail on the missed call", async () => {
    await history();
    const bobs = await timeline(bob.token, ids.bSide);
    expectStatus(bobs, 200);
    expect(bobs.json.connection).toMatchObject({ address: "jesse@home.test", name: "Jesse" });
    expect(bobs.json.retention).toEqual({
      setting: "default",
      account: "default",
      effective: "forever",
      from: "server",
    });
    expect(bobs.json.items).toMatchObject([
      {
        kind: "call",
        direction: "in",
        answered: false,
        endReason: "declined",
        voicemail: {
          durationMs: 4000,
          transcript: "heard 700 bytes",
          transcriptStatus: "done",
          heardAt: null,
          fromLabel: "Jesse",
        },
      },
      { kind: "call", direction: "in", answered: true, durationMs: 3 * 60_000, voicemail: null },
    ]);
    // Playback uses the inbox's audio route.
    const vmId = bobs.json.items[0].voicemail.id as string;
    const audio = await s.api.request(`/voicemails/${vmId}/audio`, {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(AUDIO);

    // The caller's side: two outgoing calls, and no voicemail (it's in Bob's inbox, not hers).
    const jesses = await timeline(jesse.token, ids.aSide);
    expect(jesses.json.items).toMatchObject([
      { kind: "call", direction: "out", answered: false, voicemail: null },
      { kind: "call", direction: "out", answered: true, durationMs: 3 * 60_000 },
    ]);
  });

  it("is only for the connection's owner", async () => {
    await history();
    const carol = await s.person("carol", "Carol");
    expectStatus(await timeline(carol.token, ids.bSide), 404);
    expectStatus(await timeline(jesse.token, ids.bSide), 404);
    expectStatus(
      await s.http(`/connections/${ids.bSide}/retention`, {
        method: "PUT",
        token: jesse.token,
        body: { retention: "30d" },
      }),
      404,
    );
    expectStatus(await timeline(bob.token, ids.bSide), 200);
  });

  it("follows a person after they change their handle", async () => {
    await call(jApp, bApp, ids.aSide, s, 1);
    s.timers.advance(2 * DAY_MS);
    expectStatus(
      await s.http("/account", { method: "PATCH", token: jesse.token, body: { handle: "jess" } }),
      200,
    );
    const bobs = await timeline(bob.token, ids.bSide);
    expect(bobs.json.connection.address).toBe("jess@home.test");
    expect(bobs.json.items).toHaveLength(1);
  });

  it("the data export links a call to its voicemail", async () => {
    await history();
    const exported = await s.http("/account/export", { token: bob.token });
    const withVm = exported.json.calls.find((c: { voicemailId?: string }) => c.voicemailId);
    expect(withVm).toMatchObject({ peer: "jesse@home.test", answered: false });
    expect(withVm.voicemail).toBe(`/api/voicemails/${withVm.voicemailId}/audio`);
    const audio = await s.api.request(withVm.voicemail.replace(/^\/api/, ""), {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(audio.status).toBe(200);
  });
});

describe("history expiry", () => {
  const setRetention = (token: string, id: string, retention: string) =>
    s.http(`/connections/${id}/retention`, { method: "PUT", token, body: { retention } });

  it("deletes a connection's calls, voicemails and audio after its retention", async () => {
    await history();
    expect([...s.blobs.keys()].filter((k) => k.startsWith("voicemail/"))).toHaveLength(1);
    expectStatus(await setRetention(bob.token, ids.bSide, "30d"), 204);
    expectStatus(await setRetention(bob.token, ids.bSide, "weekly"), 400);
    s.timers.advance(29 * DAY_MS);
    expect((await timeline(bob.token, ids.bSide)).json.items).toHaveLength(2);
    s.timers.advance(2 * DAY_MS);
    const after = await timeline(bob.token, ids.bSide);
    expect(after.json.retention).toMatchObject({
      setting: "30d",
      effective: "30d",
      from: "connection",
    });
    expect(after.json.items).toEqual([]);
    expect(await s.store.callLog(bob.account.id)).toEqual([]);
    expect((await s.http("/voicemails", { token: bob.token })).json).toEqual([]);
    expect([...s.blobs.keys()].filter((k) => k.startsWith("voicemail/"))).toEqual([]);
    // Jesse's own history is hers: her side keeps it (forever by default).
    expect((await timeline(jesse.token, ids.aSide)).json.items).toHaveLength(2);
  });

  it("uses the account default unless the connection overrides it", async () => {
    await history();
    expectStatus(
      await s.http("/account/retention", {
        method: "PUT",
        token: bob.token,
        body: { retention: "30d" },
      }),
      204,
    );
    expect((await s.http("/account/retention", { token: bob.token })).json).toEqual({
      retention: "30d",
    });
    // Forever for Jesse, although the account default is 30 days.
    expectStatus(await setRetention(bob.token, ids.bSide, "forever"), 204);
    s.timers.advance(40 * DAY_MS);
    const kept = await timeline(bob.token, ids.bSide);
    expect(kept.json.retention).toMatchObject({ effective: "forever", from: "connection" });
    expect(kept.json.items).toHaveLength(2);
    // Back to the account default: 30 days, so it all goes.
    expectStatus(await setRetention(bob.token, ids.bSide, "default"), 204);
    const gone = await timeline(bob.token, ids.bSide);
    expect(gone.json.retention).toMatchObject({ effective: "30d", from: "account" });
    expect(gone.json.items).toEqual([]);
  });

  it("a space's hub sweeps on activity, not on a timer", async () => {
    await history();
    expectStatus(await setRetention(bob.token, ids.bSide, "30d"), 204);
    s.timers.advance(31 * DAY_MS);
    // Nothing happened in Bob's space yet, so nothing was swept.
    expect(await s.store.callLog(bob.account.id)).toHaveLength(2);
    await s.connectApp(bob.token); // activity in Bob's space
    await vi.waitFor(async () => expect(await s.store.callLog(bob.account.id)).toEqual([]));
    await Promise.all(s.background);
    expect([...s.blobs.keys()].filter((k) => k.startsWith("voicemail/"))).toEqual([]);
  });

  it("only deletes what expired, in the swept space", async () => {
    await history();
    expectStatus(await setRetention(bob.token, ids.bSide, "30d"), 204);
    s.timers.advance(20 * DAY_MS);
    await call(jApp, bApp, ids.aSide, s, 1); // a newer call
    s.timers.advance(11 * DAY_MS);
    // Another space's sweep leaves Bob's history alone.
    await s.store.sweepExpired(jesse.household.id, "home.test", s.timers.now);
    expect(await s.store.callLog(bob.account.id)).toHaveLength(3);
    await s.store.sweepExpired(bob.household.id, "home.test", s.timers.now);
    expect(await s.store.callLog(bob.account.id)).toMatchObject([{ answered: true }]);
  });
});
