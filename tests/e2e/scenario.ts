// Backend-agnostic end-to-end scenario over real HTTP and WebSockets. Used against the self-host
// server and against `wrangler dev` / a deployed Worker.
import { fromBase64Url, toBase64Url } from "@opentincan/protocol";
import { expect, vi } from "vitest";

type Msg = { t: string; [k: string]: unknown };

export interface Target {
  /** http(s)://host:port */
  base: string;
  setupToken: string;
}

async function socket(url: string) {
  const ws = new WebSocket(url);
  const inbox: Msg[] = [];
  ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return {
    ws,
    send: (m: Msg) => ws.send(JSON.stringify(m)),
    next: (t: string) =>
      vi.waitFor(
        () => {
          const i = inbox.findIndex((m) => m.t === t);
          if (i < 0) throw new Error(`waiting for ${t}; inbox: ${JSON.stringify(inbox)}`);
          return inbox.splice(0, i + 1)[i] as Msg;
        },
        { timeout: 10_000 },
      ),
  };
}

/** Setup → pair → signed auth → app sees device → call both ways with signaling → hang up. */
export async function pairAndCall({ base, setupToken }: Target): Promise<void> {
  const ws = base.replace(/^http/, "ws");
  const setup = await fetch(`${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      householdName: "Home",
      guardianName: "Mom",
      timeZone: "UTC",
    }),
  });
  expect(setup.status).toBe(201);
  const { token, household } = (await setup.json()) as { token: string; household: { id: string } };
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

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
  const paired = await fetch(`${base}/api/devices/pair`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ code, name: "Kid phone" }),
  });
  expect(paired.status).toBe(201);
  const { deviceId } = await pairing.next("pair.done");
  pairing.ws.close();

  const device = await socket(`${ws}/ws/device?device=${deviceId}`);
  device.send({ ...hello, deviceId: deviceId as string });
  const { nonce } = await device.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, fromBase64Url(nonce as string));
  device.send({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  expect(await device.next("config")).toMatchObject({ buttons: [{ index: 0, label: "Mom" }] });

  const app = await socket(`${ws}/ws/app?household=${household.id}`);
  app.send({ t: "app.hello", proto: 1, token });
  await app.next("app.ready");
  expect(await app.next("device.status")).toMatchObject({ deviceId, online: true });
  const list = await (await fetch(`${base}/api/devices`, { headers: auth })).json();
  expect(list).toMatchObject([{ id: deviceId, online: true }]);

  // Phone calls Mom.
  device.send({ t: "hook", state: "up" });
  device.send({ t: "button", index: 0 });
  const first = (await app.next("call.ringing")).callId as string;
  app.send({ t: "call.answer", callId: first });
  expect(await device.next("rtc.config")).toHaveProperty("iceServers");
  device.send({ t: "rtc.sdp", callId: first, type: "offer", sdp: "v=0 offer" });
  expect(await app.next("rtc.sdp")).toMatchObject({ type: "offer" });
  app.send({ t: "rtc.sdp", callId: first, type: "answer", sdp: "v=0 answer" });
  expect(await device.next("rtc.sdp")).toMatchObject({ type: "answer" });
  device.send({ t: "call.hangup", callId: first });
  device.send({ t: "hook", state: "down" });
  for (;;) {
    const m = await app.next("call.state");
    if (m.state === "ended") break;
  }

  // Mom calls the phone.
  app.send({ t: "call.dial", deviceId: deviceId as string });
  const second = (await device.next("call.ringing")).callId as string;
  device.send({ t: "hook", state: "up" });
  device.send({ t: "call.answer", callId: second });
  expect(await app.next("rtc.config")).toHaveProperty("iceServers");
  app.send({ t: "call.hangup", callId: second });
  for (;;) {
    const m = await device.next("call.state");
    if (m.state === "ended") break;
  }

  // The API can't be used across households or without auth.
  expect((await fetch(`${base}/api/devices`)).status).toBe(401);

  device.ws.close();
  app.ws.close();
}
