// Interop scenario between two independent servers (federation): sign-up on each, a knock across
// servers, accept, and block. Runs against any two servers with open sign-up.
import { deviceFingerprint } from "@openloungephone/core";
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { expect } from "vitest";
import { fakeRegistration } from "./passkey.ts";
import { socket } from "./scenario.ts";

export interface ServerTarget {
  /** Where this test process reaches the server (e.g. http://127.0.0.1:8787). */
  base: string;
  /** Its public origin, which other servers and passkeys use (e.g. http://a.localhost:8787). */
  origin: string;
}

export interface Person {
  server: ServerTarget;
  token: string;
  householdId: string;
  address: string;
}

const json = { "content-type": "application/json" };

export async function api(
  p: { server: ServerTarget; token?: string },
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const res = await fetch(`${p.server.base}/api${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { ...json, ...(p.token ? { authorization: `Bearer ${p.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Open sign-up with a (software) passkey: account + personal household + session. */
export async function signUp(server: ServerTarget, handle: string, name: string): Promise<Person> {
  const opts = await api({ server }, "/signup/options", {
    body: { handle, name, timeZone: "UTC" },
  });
  expect(opts.status, JSON.stringify(opts.json)).toBe(200);
  const response = await fakeRegistration(opts.json.options, server.origin);
  const done = await api({ server }, "/signup", {
    body: { challengeId: opts.json.challengeId, response },
  });
  expect(done.status, JSON.stringify(done.json)).toBe(201);
  return {
    server,
    token: done.json.token,
    householdId: done.json.household.id,
    address: done.json.account.address,
  };
}

export async function appSocket(p: Person) {
  const ws = await socket(
    `${p.server.base.replace(/^http/, "ws")}/ws/app?household=${p.householdId}`,
  );
  ws.send({ t: "app.hello", proto: 1, token: p.token });
  await ws.next("app.ready");
  return ws;
}

type Conn = { id: string; address: string; state: string; direction: string; remote: boolean };
export const connections = async (p: Person) =>
  (await api(p, "/connections")).json.connections as Conn[];

/** Jesse (server A) knocks on Bob (server B); Bob sees it live and accepts. */
export async function knockAndAccept(jesse: Person, bob: Person) {
  const bobApp = await appSocket(bob);
  const sent = await api(jesse, "/connections", { body: { to: bob.address, note: "hi Bob" } });
  expect(sent.status, JSON.stringify(sent.json)).toBe(202);
  await bobApp.next("connections.changed");
  const [knock] = await connections(bob);
  expect(knock).toMatchObject({ address: jesse.address, state: "requested", remote: true });
  const accepted = await api(bob, `/connections/${knock?.id}/accept`, { method: "POST" });
  expect(accepted.status).toBe(200);
  expect(await connections(jesse)).toMatchObject([{ address: bob.address, state: "active" }]);
  bobApp.ws.close();
}

/** Bob blocks Jesse: the connection is gone on her side, and her next knock never arrives. */
export async function block(jesse: Person, bob: Person) {
  const [row] = await connections(bob);
  expect((await api(bob, `/connections/${row?.id}/block`, { method: "POST" })).status).toBe(204);
  expect((await connections(jesse)).filter((c) => c.address === bob.address)).toEqual([]);
  expect((await api(jesse, "/connections", { body: { to: bob.address } })).status).toBe(202);
  expect((await connections(bob)).map((c) => c.state)).toEqual(["blocked"]);
}

/** Jesse calls Bob across servers: ring, answer, offer/answer relayed, both active, hang up. */
export async function callAcross(jesse: Person, bob: Person) {
  const [row] = await connections(jesse);
  const jApp = await appSocket(jesse);
  const bApp = await appSocket(bob);
  jApp.send({ t: "call.connection", connectionId: row?.id as string });
  const ring = await bApp.next("call.ringing");
  const callId = ring.callId as string;
  bApp.send({ t: "call.answer", callId });
  expect(await jApp.next("rtc.config")).toHaveProperty("iceServers");
  expect(await bApp.next("rtc.config")).toHaveProperty("iceServers");
  jApp.send({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 offer" });
  expect(await bApp.next("rtc.sdp")).toMatchObject({ type: "offer" });
  bApp.send({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 answer" });
  expect(await jApp.next("rtc.sdp")).toMatchObject({ type: "answer" });
  for (const app of [jApp, bApp]) {
    for (;;) if ((await app.next("call.state")).state === "active") break;
  }
  jApp.send({ t: "call.hangup", callId });
  for (;;) {
    const m = await bApp.next("call.state");
    if (m.state === "ended") break;
  }
  jApp.ws.close();
  bApp.ws.close();
}

/**
 * Bob's kid's phone (on B) lists Jesse (on A); during its quiet hours her call goes to voicemail,
 * which she leaves from her own server.
 */
export async function voicemailAcross(jesse: Person, bob: Person) {
  const ws = bob.server.base.replace(/^http/, "ws");
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  const hello = {
    t: "hello",
    proto: 1,
    model: "web-emulator",
    fw: "e2e",
    buttons: 4,
    display: "eink",
  };
  const pairing = await socket(`${ws}/ws/device`);
  pairing.send(hello);
  pairing.send({ t: "pair.begin", publicKey });
  const { code } = await pairing.next("pair.code");
  expect((await api(bob, "/devices/pair", { body: { code, name: "Kid phone" } })).status).toBe(201);
  const { deviceId } = await pairing.next("pair.done");
  pairing.ws.close();
  const phone = await socket(`${ws}/ws/device?device=${deviceId}`);
  phone.send({ ...hello, deviceId: deviceId as string });
  const { nonce } = await phone.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, fromBase64Url(nonce as string));
  phone.send({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  await phone.next("config");

  const [bobsRow] = await connections(bob);
  const put = await api(bob, `/devices/${deviceId}/remote-contacts/${bobsRow?.id}`, {
    method: "PUT",
    body: { label: "Jesse", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
  });
  expect(put.status).toBe(200);
  const allDay = [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }];
  await api(bob, "/quiet-hours", { method: "PUT", body: { rules: allDay } });

  const [row] = (await api(jesse, "/connections")).json.connections as (Conn & {
    phones: { deviceId: string }[];
  })[];
  expect(row?.phones).toEqual([{ deviceId, label: "Kid phone" }]);
  const jApp = await appSocket(jesse);
  jApp.send({ t: "call.phone", connectionId: row?.id as string, deviceId: deviceId as string });
  const ended = await endedState(jApp);
  expect(ended.reason).toBe("voicemail");
  // The offer's ticket is the only credential the message needs (phones use it too).
  const ticket = (ended.voicemail as { ticket: string }).ticket;
  const bApp = await appSocket(bob);
  const recording = new Uint8Array(2048).map((_, i) => i % 199);
  const vm = await leaveMessage(jesse.server, ticket, recording, 1500);
  expect(vm.status).toBe(201);
  expect(await bApp.next("voicemail.new")).toMatchObject({ deviceId, from: "Jesse" });
  const list = (await api(bob, "/voicemails")).json as { id: string }[];
  const audio = await fetch(`${bob.server.base}/api/voicemails/${list[0]?.id}/audio`, {
    headers: { authorization: `Bearer ${bob.token}` },
  });
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(recording);
  phone.ws.close();
  jApp.ws.close();
  bApp.ws.close();
}

async function endedState(app: Awaited<ReturnType<typeof appSocket>>) {
  for (;;) {
    // Long enough for an unanswered call to ring out (the callee's ring time, 10–60 s).
    const m = await app.next("call.state", 45_000);
    if (m.state === "ended") return m;
  }
}

/** Leaves a message with a voicemail offer's ticket, on the caller's own server. */
function leaveMessage(
  server: ServerTarget,
  ticket: string,
  audio: Uint8Array<ArrayBuffer>,
  durationMs: number,
) {
  return fetch(
    `${server.base}/api/vm/message?ticket=${encodeURIComponent(ticket)}&durationMs=${durationMs}`,
    { method: "POST", headers: { "content-type": "audio/webm" }, body: audio },
  );
}

/**
 * Bob records his name as his greeting and rings for 10 s. Jesse's call across servers isn't
 * answered: her server fetches Bob's greeting from his (a signed request, only because they're
 * connected), and her message lands in Bob's own inbox.
 */
export async function noAnswerAcross(jesse: Person, bob: Person) {
  const name = new Uint8Array(600).map((_, i) => (i * 7) % 251);
  const put = await fetch(`${bob.server.base}/api/voicemail/greeting?kind=name&durationMs=1800`, {
    method: "PUT",
    headers: { authorization: `Bearer ${bob.token}`, "content-type": "audio/webm" },
    body: name,
  });
  expect(put.status).toBe(204);
  const ring = await api(bob, "/voicemail/settings", {
    method: "PATCH",
    body: { ringSeconds: 10 },
  });
  expect(ring.status).toBe(204);
  const [row] = await connections(jesse);
  const jApp = await appSocket(jesse);
  const bApp = await appSocket(bob);
  jApp.send({ t: "call.connection", connectionId: row?.id as string });
  await bApp.next("call.ringing");
  // Nobody answers.
  const ended = await endedState(jApp);
  expect(ended.reason).toBe("timeout");
  const offer = ended.voicemail as { ticket: string; name: string };
  expect(offer.name).toBe("Bob");
  const greeting = await fetch(
    `${jesse.server.base}/api/vm/greeting?ticket=${encodeURIComponent(offer.ticket)}`,
  );
  expect(greeting.status).toBe(200);
  expect(greeting.headers.get("olp-greeting")).toBe("name");
  expect(new Uint8Array(await greeting.arrayBuffer())).toEqual(name);
  const message = new Uint8Array(1500).map((_, i) => i % 97);
  expect((await leaveMessage(jesse.server, offer.ticket, message, 4000)).status).toBe(201);
  expect(await bApp.next("voicemail.inbox")).toMatchObject({ from: "Jesse" });
  const inbox = (await api(bob, "/voicemails")).json as { toUser: string; fromLabel: string }[];
  expect(inbox[0]).toMatchObject({ fromLabel: "Jesse", deviceId: null });
  expect(inbox[0]?.toUser).toBeTruthy();
  jApp.ws.close();
  bApp.ws.close();
}

/**
 * Both sides' buddy timelines after `callAcross` and `noAnswerAcross`: Jesse's server logged
 * two outgoing calls; Bob's logged them incoming, with Jesse's message on the missed one.
 */
export async function timelineAcross(jesse: Person, bob: Person) {
  const [jRow] = await connections(jesse);
  const [bRow] = await connections(bob);
  const mine = await api(jesse, `/connections/${jRow?.id}/timeline`);
  expect(mine.status).toBe(200);
  expect(mine.json.items).toMatchObject([
    { kind: "call", direction: "out", answered: false, endReason: "timeout", voicemail: null },
    { kind: "call", direction: "out", answered: true },
  ]);
  const theirs = await api(bob, `/connections/${bRow?.id}/timeline`);
  expect(theirs.json.items).toMatchObject([
    {
      kind: "call",
      direction: "in",
      answered: false,
      voicemail: { fromLabel: "Jesse", durationMs: 4000 },
    },
    { kind: "call", direction: "in", answered: true },
  ]);
  const set = await api(bob, `/connections/${bRow?.id}/retention`, {
    method: "PUT",
    body: { retention: "1y" },
  });
  expect(set.status).toBe(204);
  expect((await api(bob, `/connections/${bRow?.id}/timeline`)).json.retention).toMatchObject({
    setting: "1y",
    effective: "1y",
    from: "connection",
  });
}

/** A phone that pairs over a real socket on `owner`'s server as `mode`, then signs in. */
async function pairPhone(owner: Person, mode: "kids" | "personal" | "lounge") {
  const ws = owner.server.base.replace(/^http/, "ws");
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  const hello = {
    t: "hello",
    proto: 1,
    model: "web-emulator",
    fw: "e2e",
    buttons: 4,
    display: "eink",
  };
  const pairing = await socket(`${ws}/ws/device`);
  pairing.send(hello);
  pairing.send({ t: "pair.begin", publicKey, kind: mode });
  const { code } = await pairing.next("pair.code");
  const preview = await api(owner, "/devices/pair/preview", { body: { code } });
  expect(preview.json.mode).toBe(mode);
  // The four words the phone would show under MENU → About.
  expect(preview.json.fingerprint).toEqual(await deviceFingerprint(publicKey));
  const paired = await api(owner, "/devices/pair", { body: { code, name: "Desk" } });
  expect(paired.status).toBe(201);
  const { deviceId } = await pairing.next("pair.done");
  pairing.ws.close();
  const signIn = async () => {
    const phone = await socket(`${ws}/ws/device?device=${deviceId}`);
    phone.send({ ...hello, deviceId: deviceId as string });
    const { nonce } = await phone.next("auth.challenge");
    const sig = await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      fromBase64Url(nonce as string),
    );
    phone.send({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
    return phone;
  };
  return { deviceId: deviceId as string, signIn };
}

/**
 * Bob's own desk phone: claimed as "personal", its strip names him; removed in the app while
 * connected it wipes itself, and a second phone removed while offline wipes when it comes back.
 */
export async function removeAndWipe(bob: Person) {
  const desk = await pairPhone(bob, "personal");
  const phone = await desk.signIn();
  const config = await phone.next("config");
  expect(config.owner).toMatchObject({ mode: "personal", person: "Bob" });
  const listed = (await api(bob, "/devices")).json.find(
    (d: { id: string }) => d.id === desk.deviceId,
  );
  expect(listed).toMatchObject({ mode: "personal", fw: "e2e", model: "web-emulator" });
  expect((await api(bob, `/devices/${desk.deviceId}`, { method: "DELETE" })).status).toBe(204);
  expect(await phone.next("wipe")).toMatchObject({ reason: "removed" });

  const spare = await pairPhone(bob, "personal");
  expect((await api(bob, `/devices/${spare.deviceId}`, { method: "DELETE" })).status).toBe(204);
  const back = await spare.signIn();
  expect(await back.next("wipe")).toMatchObject({ reason: "removed" });
}

type Sock = Awaited<ReturnType<typeof appSocket>>;

/** Reads room states until one lists `n` people. */
async function roomWith(app: Sock, n: number) {
  for (;;) {
    const st = await app.next("room.state");
    if ((st.participants as unknown[]).length === n) return st;
  }
}

/**
 * Rooms across servers without a relay (a peer-to-peer mesh): Jesse makes a phone room open to
 * her connections; Bob (on the other server) joins it by address and mesh signaling crosses the
 * servers; Jesse locks it, and a second join is refused.
 */
export async function roomsAcross(jesse: Person, bob: Person) {
  const made = await api(jesse, "/rooms", {
    body: { kind: "phone", name: "Standup", handle: "standup", access: "connections" },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const host = new URL(jesse.server.origin).host;
  expect(made.json.address).toBe(`standup@${host}`);
  const jApp = await appSocket(jesse);
  const bApp = await appSocket(bob);
  jApp.send({ t: "room.join", roomId: made.json.id });
  const j = await jApp.next("room.state");
  expect(j).toMatchObject({ media: "mesh", e2ee: true });
  bApp.send({ t: "room.join", address: `standup@${host}` });
  const b = await roomWith(bApp, 2);
  await roomWith(jApp, 2);
  jApp.send({ t: "rtc.sdp", callId: made.json.id, type: "offer", sdp: "v=0 o", peer: b.you });
  expect(await bApp.next("rtc.sdp")).toMatchObject({ peer: j.you });
  // Members see who's in.
  const list = await api(jesse, "/rooms");
  expect(list.json.rooms[0].people).toEqual(["Jesse", "Bob"]);
  jApp.send({ t: "room.lock", roomId: made.json.id, locked: true });
  bApp.send({ t: "room.leave", roomId: made.json.id });
  await bApp.next("room.ended");
  await roomWith(jApp, 1);
  bApp.send({ t: "room.join", address: `standup@${host}` });
  expect(await bApp.next("room.ended")).toMatchObject({ reason: "locked" });
  jApp.send({ t: "room.leave", roomId: made.json.id });
  await jApp.next("room.ended");
  jApp.ws.close();
  bApp.ws.close();
}

/** A knock and accept between two people on the same server (another household). */
export async function connectLocally(jesse: Person, carol: Person) {
  expect((await api(jesse, "/connections", { body: { to: carol.address } })).status).toBe(202);
  const knock = (await connections(carol)).find((c) => c.address === jesse.address);
  expect(knock).toMatchObject({ state: "requested", remote: false });
  expect((await api(carol, `/connections/${knock?.id}/accept`, { method: "POST" })).status).toBe(
    200,
  );
}

/** One side answers, the offer and answer cross, and both are active. */
async function answered(caller: Sock, callee: Sock) {
  const ring = await callee.next("call.ringing");
  const callId = ring.callId as string;
  callee.send({ t: "call.answer", callId });
  await caller.next("rtc.config");
  caller.send({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0 o" });
  await callee.next("rtc.sdp");
  callee.send({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0 a" });
  for (;;) if ((await caller.next("call.state")).state === "active") break;
  return callId;
}

/**
 * 3-way across households and servers: Jesse calls Bob (other server), holds him, calls Carol
 * (another household on her own server) and merges: all three end up in one room.
 */
export async function mergeAcross(jesse: Person, bob: Person, carol: Person) {
  const toBob = (await connections(jesse)).find((c) => c.address === bob.address);
  const toCarol = (await connections(jesse)).find((c) => c.address === carol.address);
  const jApp = await appSocket(jesse);
  const bApp = await appSocket(bob);
  const cApp = await appSocket(carol);
  jApp.send({ t: "call.connection", connectionId: toBob?.id as string });
  const first = await answered(jApp, bApp);
  jApp.send({ t: "call.hold", callId: first, hold: true });
  for (;;) if ((await bApp.next("call.state")).hold === "them") break;
  jApp.send({ t: "call.connection", connectionId: toCarol?.id as string });
  const second = await answered(jApp, cApp);
  jApp.send({ t: "call.merge", callId: first, with: second });
  for (const app of [bApp, cApp]) {
    for (;;) {
      const m = await app.next("call.state");
      if (m.state === "ended") {
        expect(m.merged).toBeTruthy();
        break;
      }
    }
  }
  const room = await roomWith(jApp, 3);
  expect(room).toMatchObject({ kind: "call", media: "mesh" });
  expect((await roomWith(bApp, 3)).roomId).toBe(room.roomId);
  expect((await roomWith(cApp, 3)).roomId).toBe(room.roomId);
  // Everyone's audio travels peer to peer: Bob's offer to Carol goes through both servers.
  const bob3 = (room.participants as { id: string; name: string }[]).find((p) => p.name === "Bob");
  const carol3 = (room.participants as { id: string; name: string }[]).find(
    (p) => p.name === "Carol",
  );
  bApp.send({ t: "rtc.sdp", callId: room.roomId, type: "offer", sdp: "v=0 b", peer: carol3?.id });
  expect(await cApp.next("rtc.sdp")).toMatchObject({ peer: bob3?.id, sdp: "v=0 b" });
  for (const app of [bApp, cApp]) app.send({ t: "room.leave", roomId: room.roomId });
  expect(await jApp.next("room.ended")).toMatchObject({ reason: "closed" });
  for (const app of [jApp, bApp, cApp]) app.ws.close();
}

/** Waits for a `call.state` with this state; returns it. */
async function stateOf(app: Sock, state: string) {
  for (;;) {
    const m = await app.next("call.state");
    if (m.state === state) return m;
  }
}

/**
 * A team space on server A (docs/workplace.md): Olga makes it, Ben joins by invite, Olga gives
 * Ben an extension and a "Support" ring group. Bob (server B) calls Olga; she answers in the
 * team and transfers him to extension 300 — a transfer across servers, which a team space
 * allows — so Ben's app rings and Bob's server carries Bob's call over. The admin call log shows
 * the calls.
 */
export async function workplaceAcross(server: ServerTarget, bob: Person) {
  {
    const olgaHome = await signUp(server, "olga", "Olga");
    const made = await api(olgaHome, "/spaces", { body: { name: "Acme", type: "team" } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const olga: Person = { ...olgaHome, householdId: made.json.household.id };
    const benHome = await signUp(server, "ben", "Ben");
    const invite = await api(olga, "/invites", { body: { name: "Ben", role: "contact" } });
    expect(invite.status).toBe(201);
    const joined = await api(benHome, "/invites/accept", { body: { token: invite.json.token } });
    expect(joined.status, JSON.stringify(joined.json)).toBe(201);
    const ben: Person = { ...benHome, householdId: made.json.household.id };
    const benUser = joined.json.user.id as string;
    expect(
      (
        await api(olga, "/extensions/201", {
          method: "PUT",
          body: { kind: "user", targetId: benUser },
        })
      ).status,
    ).toBe(204);
    const group = await api(olga, "/groups", {
      body: { name: "Support", extension: "300", members: [benUser] },
    });
    expect(group.status, JSON.stringify(group.json)).toBe(201);
    const dir = await api(ben, "/directory?q=sup");
    expect(dir.json.groups).toMatchObject([{ name: "Support", extension: "300" }]);
    // The team records its calls (off by default; announced to everyone, other servers too).
    expect(
      (await api(olga, "/space/recording", { method: "PUT", body: { enabled: true } })).status,
    ).toBe(204);

    // Bob and Olga connect across servers.
    expect((await api(bob, "/connections", { body: { to: olga.address } })).status).toBe(202);
    const knock = (await connections(olga)).find((c) => c.address === bob.address);
    expect((await api(olga, `/connections/${knock?.id}/accept`, { method: "POST" })).status).toBe(
      200,
    );
    const toOlga = (await connections(bob)).find((c) => c.address === olga.address);

    const bApp = await appSocket(bob);
    const oApp = await appSocket(olga);
    const benApp = await appSocket(ben);
    bApp.send({ t: "call.connection", connectionId: toOlga?.id as string });
    // Olga answers in the team: her call there has its own id (the team is one of her spaces).
    const bCall = (await stateOf(bApp, "ringing")).callId as string;
    const first = (await oApp.next("call.ringing")).callId as string;
    oApp.send({ t: "call.answer", callId: first });
    await stateOf(bApp, "connecting");
    bApp.send({ t: "rtc.sdp", callId: bCall, type: "offer", sdp: "v=0 o" });
    expect(await oApp.next("rtc.sdp")).toMatchObject({ callId: first, sdp: "v=0 o" });
    oApp.send({ t: "rtc.sdp", callId: first, type: "answer", sdp: "v=0 a" });
    await stateOf(oApp, "active");
    await stateOf(bApp, "active");
    // Bob hears from his own server that the call is recorded (no ticket: it's not his to make);
    // Olga's app is the one that records.
    const bobNotice = (await stateOf(bApp, "active")).recording as { by: string; ticket?: string };
    expect(bobNotice).toEqual({ by: "Acme" });
    const olgaNotice = (await stateOf(oApp, "active")).recording as { ticket: string };
    expect(olgaNotice.ticket).toBeTruthy();
    oApp.send({ t: "call.transfer", callId: first, to: { extension: "300" } });
    // Olga's call is over for her: her app uploads what it recorded.
    await stateOf(oApp, "ended");
    const up = await fetch(
      `${server.base}/api/rec/upload?ticket=${olgaNotice.ticket}&durationMs=3000`,
      {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(up.status).toBe(201);
    const moved = await stateOf(bApp, "ended");
    expect(moved.transfer).toMatchObject({ ringing: true, offerer: true });
    const next = (moved.transfer as { callId: string }).callId;
    const ring = await benApp.next("call.ringing");
    expect(ring.from).toMatchObject({ label: "Bob" });
    benApp.send({ t: "call.answer", callId: ring.callId });
    const connecting = await stateOf(bApp, "connecting");
    expect(connecting.callId).toBe(next);
    bApp.send({ t: "rtc.sdp", callId: next, type: "offer", sdp: "v=0 to-ben" });
    expect(await benApp.next("rtc.sdp")).toMatchObject({ sdp: "v=0 to-ben" });
    benApp.send({ t: "rtc.sdp", callId: ring.callId, type: "answer", sdp: "v=0 from-ben" });
    expect(await bApp.next("rtc.sdp")).toMatchObject({ callId: next, sdp: "v=0 from-ben" });
    await stateOf(bApp, "active");
    bApp.send({ t: "call.hangup", callId: next });
    await stateOf(benApp, "ended");
    const log = await api(olga, "/space/calls");
    expect(log.status).toBe(200);
    expect((log.json as { recordingId: string | null }[]).some((r) => r.recordingId)).toBe(true);
    expect((await api(olga, "/recordings")).json.length).toBeGreaterThanOrEqual(1);
    expect((log.json as { who: string }[]).map((r) => r.who)).toEqual(
      expect.arrayContaining(["Olga", "Ben"]),
    );
    for (const app of [bApp, oApp, benApp]) app.ws.close();
  }
}
