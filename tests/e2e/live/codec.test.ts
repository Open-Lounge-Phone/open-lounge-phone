// Call audio codecs on the firmware, end to end and entirely local (docs/audio.md item 2): a
// self-hosted server on this machine, the phone's real firmware in QEMU (its test audio device: a
// tone for a mic, an analysing earpiece) and the companion app in headless Chromium (a tone file
// for a mic). Each call checks which codec both sides use and that audio flows both ways:
//
//   1. the companion calls the phone: Opus (16 kHz wideband: the phone hears a 5 kHz tone)
//   2. the same with Opus taken out of the companion's offer: PCMU (no 5 kHz: telephone band)
//   3. the phone calls the companion: its offer has Opus and PCMU, the answer picks Opus
//      (negotiation only: see the case)
//   4. the phone check's echo test (MENU 7 2): it runs, and finds no echo (none in QEMU)
// The echo canceller is on for call 1.
//
//   OLP_CODEC_E2E=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROME=/path/to/chrome] \
//     npx vitest run tests/e2e/live/codec.test.ts
//
// Env: OLP_FW_NO_BUILD=1 (reuse the last build), OLP_CODEC_BUILD (the QEMU build directory, under
// firmware/ or absolute; default build-qemu-codec), OLP_LIVE_OUT (logs; default
// <build>/codec-e2e), OLP_CODEC_CASES (e.g. `1,2`: only those).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, ProcLog } from "../procs.ts";
import { api, type ServerTarget, signUp } from "../twoServers.ts";
import { CHROMIUM_ARGS, Companion, until } from "./browser.ts";
import { parseAudioLine } from "./media.ts";
import { FIRMWARE, QemuPhone } from "./wokwi.ts";

const ON = process.env.OLP_CODEC_E2E === "1";
const BUILD = process.env.OLP_CODEC_BUILD ?? "build-qemu-codec";
const OUT = process.env.OLP_LIVE_OUT ?? join(resolve(FIRMWARE, BUILD), "codec-e2e");
const CASES = process.env.OLP_CODEC_CASES?.split(",").map((s) => s.trim());
const want = (c: string) => !CASES || CASES.includes(c);
const MAIN = fileURLToPath(new URL("../../../apps/server-selfhost/src/main.ts", import.meta.url));
const PHONE_HZ = 6000; // the phone's test mic (wideband only: above the telephone band)
const COMPANION_HZ = 5000; // the companion's fake mic

let server: ServerTarget;
let proc: ChildProcess | undefined;
let port = 0;
let dataDir = "";
let browser: Browser | undefined;
let phone: QemuPhone | undefined;
let stun: Socket | undefined;
const serverLog = new ProcLog("selfhost-codec");

/** A 16-bit mono 48 kHz WAV of a pulsed tone (Chromium loops it as the fake microphone). */
function toneWav(file: string, hz: number): void {
  const rate = 48_000;
  const n = rate * 10;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const on = i % 48_000 < 36_000; // 0.75 s on, 0.25 s off (no noise suppression learning it)
    const s = on ? 0.25 * 32767 * Math.sin((2 * Math.PI * hz * i) / rate) : 0;
    data.writeInt16LE(Math.round(s), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

/**
 * In the companion's page: `window.__olpCodec = "PCMU"` keeps only that codec in the offers and
 * answers it makes (setCodecPreferences on the audio transceivers), as a peer without Opus would.
 */
function codecHook(): void {
  const w = window as unknown as { __olpCodec?: string };
  const P = window.RTCPeerConnection?.prototype as RTCPeerConnection | undefined;
  if (!P || (P as unknown as { __olpCodecHooked?: boolean }).__olpCodecHooked) return;
  (P as unknown as { __olpCodecHooked?: boolean }).__olpCodecHooked = true;
  const restrict = (pc: RTCPeerConnection) => {
    if (!w.__olpCodec) return;
    const want = `audio/${w.__olpCodec}`.toLowerCase();
    const all = RTCRtpReceiver.getCapabilities("audio")?.codecs ?? [];
    const keep = all.filter((c) => c.mimeType.toLowerCase() === want);
    for (const t of pc.getTransceivers()) {
      if (t.receiver.track?.kind === "audio") t.setCodecPreferences(keep);
    }
  };
  const offer = P.createOffer;
  const answer = P.createAnswer;
  P.createOffer = function (this: RTCPeerConnection, ...a: unknown[]) {
    restrict(this);
    return (offer as (...x: unknown[]) => Promise<RTCSessionDescriptionInit>).apply(this, a);
  } as typeof P.createOffer;
  P.createAnswer = function (this: RTCPeerConnection, ...a: unknown[]) {
    restrict(this);
    return (answer as (...x: unknown[]) => Promise<RTCSessionDescriptionInit>).apply(this, a);
  } as typeof P.createAnswer;
}

interface Side {
  recv: string;
  send: string;
  received: number;
  sent: number;
  concealed: number;
  total: number;
  toneOverMedianDb: number;
}

/** The companion's newest peer connection: codecs both ways, packets, and the phone's tone. */
async function companionSide(page: Page, hz: number): Promise<Side> {
  return page.evaluate(async (watch: number) => {
    const pc = (
      window as unknown as { __olp?: { pcs: { pc: RTCPeerConnection }[] } }
    ).__olp?.pcs.at(-1)?.pc;
    if (!pc) throw new Error("no RTCPeerConnection");
    const stats = await pc.getStats();
    // biome-ignore lint/suspicious/noExplicitAny: RTCStats records are loosely typed
    let inb: any, outb: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") inb = r;
      if (r.type === "outbound-rtp" && r.kind === "audio") outb = r;
    });
    const codec = (id?: string) => (id ? String(stats.get(id)?.mimeType ?? "?") : "?");
    let over = 0;
    const track = pc.getReceivers().find((r) => r.track?.kind === "audio")?.track;
    if (track) {
      const el = new Audio();
      el.srcObject = new MediaStream([track]);
      el.muted = true;
      await el.play().catch(() => {});
      const ctx = new AudioContext();
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const bins = new Float32Array(an.frequencyBinCount);
      const binHz = ctx.sampleRate / an.fftSize;
      for (let k = 0; k < 10; k++) {
        await new Promise((r) => setTimeout(r, 200));
        an.getFloatFrequencyData(bins);
        let peak = -Infinity;
        for (let i = Math.floor((watch - 40) / binHz); i <= Math.ceil((watch + 40) / binHz); i++)
          peak = Math.max(peak, bins[i] as number);
        const sorted = Array.from(bins.slice(1, Math.floor(8000 / binHz))).sort((a, b) => a - b);
        const d = peak - (sorted[Math.floor(sorted.length / 2)] as number);
        if (Number.isFinite(d)) over = Math.max(over, d);
      }
      el.pause();
      await ctx.close();
    }
    return {
      recv: codec(inb?.codecId),
      send: codec(outb?.codecId),
      received: inb?.packetsReceived ?? 0,
      sent: outb?.packetsSent ?? 0,
      concealed: inb?.concealedSamples ?? 0,
      total: inb?.totalSamplesReceived ?? 0,
      toneOverMedianDb: Math.round(over),
    };
  }, hz);
}

/**
 * A minimal STUN server (RFC 5389 Binding only) on this machine's LAN address. Without one the
 * phone in QEMU only has its host candidate (10.0.2.15, behind QEMU's NAT): as the controlling
 * side (it placed the call) esp_peer then won't nominate the pair the browser's checks map to
 * the host's address. With it the phone learns that address as its server-reflexive candidate.
 */
async function startStun(): Promise<string> {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  if (!ip) throw new Error("no LAN IPv4 address for the STUN server");
  const sock = createSocket("udp4");
  stun = sock;
  sock.on("message", (msg, from) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0); // Binding success
    res.writeUInt16BE(12, 2);
    msg.copy(res, 4, 4, 20); // magic cookie + transaction id
    res.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    res.writeUInt16BE(8, 22);
    res.writeUInt16BE(0x0001, 24);
    res.writeUInt16BE(from.port ^ 0x2112, 26);
    const a = from.address.split(".").map(Number) as [number, number, number, number];
    const x = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) ^ 0x2112a442;
    res.writeUInt32BE(x >>> 0, 28);
    sock.send(res, from.port, from.address);
  });
  await new Promise<void>((r) => sock.bind(0, ip, () => r()));
  return `stun:${ip}:${sock.address().port}`;
}

async function startServer(): Promise<void> {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "olp-codec-"));
  const stunUrl = await startStun();
  // localhost: a secure context for the companion's microphone.
  const origin = `http://localhost:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: origin,
      DATA_DIR: dataDir,
      OPEN_SIGNUP: "1",
      STUN_URLS: stunUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", serverLog.add);
  proc.stderr?.on("data", serverLog.add);
  await until("server listening", () => serverLog.text.includes("listening on"), 20_000, 200);
  server = { base: `http://127.0.0.1:${port}`, origin };
}

let g: Companion;

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(OUT, { recursive: true });
  if (process.env.OLP_FW_NO_BUILD !== "1") {
    const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["build"], {
      encoding: "utf8",
      env: { ...process.env, OLP_QEMU_BUILD: BUILD, OLP_SIM_SERVER: "" },
    });
    if (r.status !== 0) throw new Error(`qemu build failed:\n${r.stdout}\n${r.stderr}`);
  }
  await startServer();
  const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
  const chromium = pw.chromium ?? pw.default?.chromium;
  const wav = join(OUT, `tone${COMPANION_HZ}.wav`);
  toneWav(wav, COMPANION_HZ);
  browser = (await chromium.launch({
    headless: true,
    args: [...CHROMIUM_ARGS, `--use-file-for-fake-audio-capture=${wav}`],
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  })) as Browser;
  const mom = await signUp(server, "mom", "Mom");
  g = new Companion(server.origin, "mom");
  await g.open(browser);
  await g.context.addInitScript(codecHook);
  await g.resume(mom.token);
  g.person = mom;

  phone = new QemuPhone(join(OUT, "phone.log"));
  phone.buildDir = BUILD;
  phone.start();
  await phone.consoleReady(120_000);
  phone.send(`server ws://10.0.2.2:${port}`);
  await phone.waitFor(/STRIP \[PAIR (\d{3}) (\d{3})/, 180_000, "pairing code");
  // Pointing it at the server may start pairing twice: the newest code counts.
  await new Promise((r) => setTimeout(r, 3_000));
  const codes = [...(phone as QemuPhone).log.matchAll(/PAIRING CODE: (\d{6})/g)];
  const res = await api(mom, "/devices/pair", {
    body: { code: codes.at(-1)?.[1], name: "Lily", mode: "kids" },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  await phone.waitFor(/SIGNED IN as dev_/, 180_000, "signed in");
  phone.send(`audio source ${PHONE_HZ}`);
  // The echo canceller on for the first call: it runs on the call's mic (the test device has no
  // echo to remove). QEMU runs it several times slower than the chip, too slow for the earpiece to
  // keep up, so the other calls go without it.
  phone.send("audio echo on");
  phone.send(`audio watch ${COMPANION_HZ}`);
}, 900_000);

afterAll(async () => {
  await phone?.stop();
  await browser?.close().catch(() => {});
  proc?.kill("SIGTERM");
  stun?.close();
  if (ON) writeFileSync(join(OUT, "server.log"), serverLog.text);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

/** Sets the companion's codec restriction ("" = everything it has). */
async function companionCodec(codec: string): Promise<void> {
  await g.page.evaluate((c: string) => {
    (window as unknown as { __olpCodec?: string }).__olpCodec = c || undefined;
  }, codec);
}

/** Talks for a while, then reads both ends. */
async function measure(p: QemuPhone, callStart: number) {
  await until("media connected", () => /RTC CONNECTED/.exec(p.log.slice(callStart)), 90_000);
  const codecLine = await until(
    "the phone's codec line",
    () => /CODEC send=(\w+) recv=(\w+)/.exec(p.log.slice(callStart)),
    30_000,
  );
  await g.page.waitForTimeout(10_000);
  p.send("audio");
  const line = await p.waitFor(/AUDIO device=\S+ call=1 [^\n]*/, 20_000, "audio status");
  const a = parseAudioLine(line[0]) ?? {};
  const c = await companionSide(g.page, PHONE_HZ);
  const summary = { phone: { send: codecLine[1], recv: codecLine[2], ...a }, companion: c };
  console.log(`CODEC ${JSON.stringify(summary)}`);
  return { a, c, send: codecLine[1] as string, recv: codecLine[2] as string };
}

async function hangUpBoth(p: QemuPhone): Promise<void> {
  p.send("hook down");
  await p.waitFor(/STATE idle/, 20_000);
  await g.ended().catch(() => {});
}

it.skipIf(!ON || !want("1"))(
  "1: the companion calls the phone: Opus at 16 kHz",
  async () => {
    const p = phone as QemuPhone;
    await companionCodec("");
    const start = p.log.length;
    await g.tab("Home");
    await g.page
      .locator("li.device", { hasText: "Lily" })
      .getByRole("button", { name: "Call" })
      .click();
    await p.waitFor(/STRIP \[MOM CALLING/, 30_000, "ringing");
    p.send("hook up");
    try {
      const { a, c, send, recv } = await measure(p, start);
      expect(send).toBe("opus");
      expect(recv).toBe("opus");
      expect(c.recv.toLowerCase()).toBe("audio/opus");
      expect(c.send.toLowerCase()).toBe("audio/opus");
      expect(c.received).toBeGreaterThan(200);
      expect(a.rx ?? 0).toBeGreaterThan(200);
      // Wideband both ways: tones above the telephone band get through.
      expect(c.toneOverMedianDb).toBeGreaterThanOrEqual(20);
      expect(a[`rx${COMPANION_HZ}Hz`] ?? -100).toBeGreaterThan(-45);
    } finally {
      await hangUpBoth(p);
    }
  },
  300_000,
);

it.skipIf(!ON || !want("2"))(
  "2: the companion calls without Opus in its offer: PCMU",
  async () => {
    const p = phone as QemuPhone;
    await companionCodec("PCMU");
    p.send("audio echo off");
    const start = p.log.length;
    await g.tab("Home");
    await g.page
      .locator("li.device", { hasText: "Lily" })
      .getByRole("button", { name: "Call" })
      .click();
    await p.waitFor(/STRIP \[MOM CALLING/, 30_000, "ringing");
    p.send("hook up");
    try {
      const { a, c, send, recv } = await measure(p, start);
      expect(send).toBe("pcmu");
      expect(recv).toBe("pcmu");
      expect(c.recv.toLowerCase()).toBe("audio/pcmu");
      expect(c.received).toBeGreaterThan(200);
      expect(a.rx ?? 0).toBeGreaterThan(200);
      // Telephone band: the 5 and 6 kHz tones don't get through.
      expect(c.toneOverMedianDb).toBeLessThan(15);
      expect(a[`rx${COMPANION_HZ}Hz`] ?? -100).toBeLessThan(-50);
      // …but audio does: the phone's 6 kHz tone is gone, so check the received level instead.
      expect(a.rxlevel ?? -100).toBeGreaterThan(-60);
    } finally {
      await hangUpBoth(p);
      await companionCodec("");
    }
  },
  300_000,
);

it.skipIf(!ON || !want("3"))(
  "3: the phone calls the companion: its offer has Opus and PCMU, the answer picks Opus",
  async () => {
    // Negotiation only: in QEMU (behind its NAT, no TURN here) esp_peer as the controlling side
    // won't nominate the pair the browser's checks map to, so the media of a call the phone
    // places doesn't connect; the live firmware test covers that over TURN.
    const p = phone as QemuPhone;
    await companionCodec("");
    const start = p.log.length;
    p.send("hook up");
    await p.waitFor(/STATE offhook/, 10_000);
    p.send("key 1");
    await g.answer();
    try {
      await until(
        "the phone's offer",
        () => /RTC start: offerer, [^\n]*, sends opus/.exec(p.log.slice(start)),
        30_000,
      );
      const offer = await p.waitFor(
        /-> \{"t":"rtc\.sdp","callId":"[^"]+","type":"offer","sdp":"([^"]+)"/,
        30_000,
        "offer",
      );
      const sdp = (offer[1] as string).replace(/\\r\\n/g, "\n");
      expect(sdp).toMatch(/m=audio \d+ \S+ 111 0/);
      expect(sdp).toMatch(/a=rtpmap:111 opus\/48000\/2/);
      expect(sdp).toMatch(/a=fmtp:111 [^\n]*useinbandfec=1/);
      await p.waitFor(/remote SDP has opus pcmu/, 30_000, "the answer");
    } finally {
      await hangUpBoth(p);
    }
  },
  300_000,
);

it.skipIf(!ON || !want("4"))(
  "4: the phone check's echo test",
  async () => {
    const p = phone as QemuPhone;
    p.send("audio source 0"); // a quiet mic: only an echo would be heard
    p.send("hook up");
    await p.waitFor(/STATE offhook/, 10_000);
    for (const k of ["menu", "7", "2"]) p.send(`key ${k}`);
    try {
      await p.waitFor(/ECHOTEST started/, 20_000, "echo test started");
      const r = await p.waitFor(
        /ECHOTEST heard=(\d) erl=(-?[\d.]+) delay=/,
        30_000,
        "echo test result",
      );
      expect(r[1]).toBe("0"); // the test device's earpiece doesn't reach its mic
      expect(Number(r[2])).toBeGreaterThan(30);
      await p.waitFor(/CHECK [^\n]*echo=\[OVER \d+ DB GOOD\]/, 20_000, "the check page");
    } finally {
      p.send("key menu");
      p.send("hook down");
      p.send(`audio source ${PHONE_HZ}`);
      await p.waitFor(/STATE idle/, 20_000);
    }
  },
  120_000,
);
