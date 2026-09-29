// Interop scenario between two independent servers (federation): sign-up on each, a knock across
// servers, accept, and block. Runs against any two servers with open sign-up.
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
  expect(await connections(jesse)).toEqual([]);
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
  for (;;) {
    const m = await jApp.next("call.state");
    if (m.state === "ended") {
      expect(m.reason).toBe("voicemail");
      break;
    }
  }
  const bApp = await appSocket(bob);
  const recording = new Uint8Array(2048).map((_, i) => i % 199);
  const vm = await fetch(
    `${jesse.server.base}/api/connections/${row?.id}/voicemail?deviceId=${deviceId}&durationMs=1500`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${jesse.token}`, "content-type": "audio/webm" },
      body: recording,
    },
  );
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
