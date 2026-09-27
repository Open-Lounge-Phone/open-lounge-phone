import { describe, expect, it } from "vitest";
import {
  type AppToServer,
  type DeviceToServer,
  decodeAppToServer,
  decodeDeviceToServer,
  decodeServerToApp,
  decodeServerToDevice,
  encode,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  type ServerToApp,
  type ServerToDevice,
} from "./index.ts";

const KEY = "A".repeat(43);
const SIG = "B".repeat(86);

const deviceToServer: DeviceToServer[] = [
  {
    t: "hello",
    proto: PROTOCOL_VERSION,
    model: "web-emulator",
    fw: "0.1.0",
    buttons: 4,
    display: "eink",
  },
  {
    t: "hello",
    id: "m1",
    proto: 1,
    deviceId: "dev_1",
    model: "esp32s3",
    fw: "1.2.3",
    buttons: 8,
    display: "none",
  },
  { t: "pair.begin", publicKey: KEY },
  { t: "auth.proof", sig: SIG },
  { t: "hook", state: "up" },
  { t: "button", index: 3 },
  { t: "status", battery: { pct: 14, charging: false }, rssi: -61, uptimeS: 3600 },
  { t: "status" },
  { t: "call.answer", callId: "c1" },
  { t: "call.hangup", callId: "c1" },
  { t: "rtc.sdp", callId: "c1", type: "offer", sdp: "v=0\r\n" },
  { t: "rtc.ice", callId: "c1", candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0" },
  { t: "rtc.ice", callId: "c1", candidate: null },
  { t: "ping" },
];

const serverToDevice: ServerToDevice[] = [
  { t: "auth.challenge", nonce: "n".repeat(43) },
  { t: "pair.code", code: "042917", expiresAt: 1_700_000_000_000 },
  { t: "pair.done", deviceId: "dev_1", householdId: "hh_1" },
  { t: "config", buttons: [{ index: 0, label: "Mom" }], quiet: false },
  { t: "call.ringing", callId: "c1", from: { label: "Grandma" } },
  { t: "call.state", callId: "c1", state: "ended", reason: "voicemail" },
  { t: "rtc.config", callId: "c1", iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }] },
  { t: "rtc.sdp", callId: "c1", type: "answer", sdp: "v=0\r\n" },
  { t: "error", code: "bad_message", message: "nope", ref: "m1" },
  { t: "pong" },
];

const appToServer: AppToServer[] = [
  { t: "app.hello", proto: 1, token: "t".repeat(32) },
  { t: "call.dial", deviceId: "dev_1" },
  { t: "call.hangup", callId: "c1" },
];

const serverToApp: ServerToApp[] = [
  { t: "app.ready", userId: "u_1" },
  {
    t: "device.status",
    deviceId: "dev_1",
    online: true,
    battery: { pct: 80, charging: true },
    lastSeen: 1,
  },
  { t: "call.state", callId: "c1", state: "active" },
];

describe("round trip", () => {
  it.each(deviceToServer)("device->server $t", (msg) => {
    expect(decodeDeviceToServer(encode(msg))).toEqual({ ok: true, msg });
  });
  it.each(serverToDevice)("server->device $t", (msg) => {
    expect(decodeServerToDevice(encode(msg))).toEqual({ ok: true, msg });
  });
  it.each(appToServer)("app->server $t", (msg) => {
    expect(decodeAppToServer(encode(msg))).toEqual({ ok: true, msg });
  });
  it.each(serverToApp)("server->app $t", (msg) => {
    expect(decodeServerToApp(encode(msg))).toEqual({ ok: true, msg });
  });
});

describe("rejection", () => {
  it("rejects non-JSON", () => {
    expect(decodeDeviceToServer("{nope")).toMatchObject({ ok: false, error: "not_json" });
  });

  it("rejects unknown message types", () => {
    expect(decodeDeviceToServer('{"t":"reboot"}')).toMatchObject({ ok: false, error: "invalid" });
  });

  it("rejects messages from the wrong direction", () => {
    // A device must not be able to send server-only messages such as pair.done.
    const raw = encode({ t: "pair.done", deviceId: "d", householdId: "h" });
    expect(decodeDeviceToServer(raw)).toMatchObject({ ok: false, error: "invalid" });
    // Apps cannot pretend to be devices.
    expect(decodeAppToServer(encode({ t: "button", index: 0 }))).toMatchObject({ ok: false });
  });

  it("reports the offending field", () => {
    const res = decodeDeviceToServer(encode({ t: "button", index: 99 }));
    expect(res).toMatchObject({ ok: false, error: "invalid" });
    expect(!res.ok && res.detail).toMatch(/^index:/);
  });

  it("rejects malformed keys, codes and ids", () => {
    expect(decodeDeviceToServer(encode({ t: "pair.begin", publicKey: "short" })).ok).toBe(false);
    expect(decodeServerToDevice(encode({ t: "pair.code", code: "12a456", expiresAt: 0 })).ok).toBe(
      false,
    );
    expect(decodeDeviceToServer(encode({ t: "call.answer", callId: "../etc" })).ok).toBe(false);
  });

  it("rejects oversized messages before parsing", () => {
    const sdp = "a".repeat(MAX_MESSAGE_BYTES);
    const res = decodeDeviceToServer(encode({ t: "rtc.sdp", callId: "c", type: "offer", sdp }));
    expect(res).toMatchObject({ ok: false, error: "too_large" });
  });

  it("counts multi-byte characters toward the size limit", () => {
    const label = "é".repeat(MAX_MESSAGE_BYTES / 2);
    expect(decodeDeviceToServer(encode({ t: "ping", id: label }))).toMatchObject({
      ok: false,
      error: "too_large",
    });
  });
});
