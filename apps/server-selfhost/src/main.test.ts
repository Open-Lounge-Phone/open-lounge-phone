import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBase64Url, toBase64Url } from "@opentincan/protocol";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";
import { start } from "./main.ts";

let server: Awaited<ReturnType<typeof start>>;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "otc-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = await start(
    loadConfig({ PORT: "0", HOST: "127.0.0.1", DATA_DIR: dataDir, STUN_URLS: "" }),
  );
  base = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Msg = { t: string; [k: string]: unknown };

/** A WebSocket client that queues incoming messages for `next(t)`. */
async function socket(path: string) {
  const ws = new WebSocket(`ws://${base}${path}`);
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
      vi.waitFor(() => {
        const i = inbox.findIndex((m) => m.t === t);
        if (i < 0) throw new Error(`waiting for ${t}`);
        return inbox.splice(0, i + 1)[i] as Msg;
      }),
  };
}

it("pairs a device over real sockets and places a call", async () => {
  // First-run setup via HTTP.
  const setup = await fetch(`http://${base}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: server.setupToken,
      householdName: "Home",
      guardianName: "Mom",
      timeZone: "UTC",
    }),
  });
  expect(setup.status).toBe(201);
  const { token } = (await setup.json()) as { token: string };
  const auth = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // Pair.
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
  const pairing = await socket("/ws/device");
  pairing.send(hello);
  pairing.send({ t: "pair.begin", publicKey });
  const { code } = await pairing.next("pair.code");
  const paired = await fetch(`http://${base}/api/devices/pair`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ code, name: "Kid phone" }),
  });
  expect(paired.status).toBe(201);
  const { deviceId } = await pairing.next("pair.done");
  pairing.ws.close();

  // Authenticate.
  const device = await socket("/ws/device");
  device.send({ ...hello, deviceId: deviceId as string });
  const { nonce } = await device.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, fromBase64Url(nonce as string));
  device.send({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  expect(await device.next("config")).toMatchObject({ buttons: [{ index: 0, label: "Mom" }] });

  // Companion app connects and sees the device online.
  const app = await socket("/ws/app");
  app.send({ t: "app.hello", proto: 1, token });
  await app.next("app.ready");
  expect(await app.next("device.status")).toMatchObject({ deviceId, online: true });
  const list = await (await fetch(`http://${base}/api/devices`, { headers: auth })).json();
  expect(list).toMatchObject([{ id: deviceId, name: "Kid phone", online: true }]);

  // Call.
  device.send({ t: "hook", state: "up" });
  device.send({ t: "button", index: 0 });
  const { callId } = await app.next("call.ringing");
  app.send({ t: "call.answer", callId: callId as string });
  expect(await device.next("rtc.config")).toMatchObject({ iceServers: [] });
  device.send({ t: "rtc.sdp", callId: callId as string, type: "offer", sdp: "v=0" });
  expect(await app.next("rtc.sdp")).toMatchObject({ type: "offer", sdp: "v=0" });
  device.send({ t: "call.hangup", callId: callId as string });

  device.ws.close();
  app.ws.close();
});

it("serves the API and rejects unknown socket paths", async () => {
  expect(await (await fetch(`http://${base}/api/health`)).json()).toEqual({ ok: true });
  const ws = new WebSocket(`ws://${base}/ws/nope`);
  await new Promise((resolve) => ws.addEventListener("error", resolve));
});
