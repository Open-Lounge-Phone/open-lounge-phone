// The phone firmware's 0.9.4 features end to end in QEMU, entirely local: a self-hosted server on
// this machine and three phones on one Ethernet segment (each QEMU sends its frames to a small UDP
// hub here; the first phone has QEMU's user network, hands out the addresses and routes to the
// server at 10.0.2.2). Nothing leaves the machine.
//
//   OLP_HOME_QEMU=1 npx vitest run tests/e2e/live/home.test.ts
//
// Env: OLP_FW_NO_BUILD=1 (reuse the last `firmware/tools/qemu.sh build`), OLP_LIVE_OUT (logs;
// default firmware/build-qemu/home).
//
// - house intercom: two phones of one space find each other and call room to room (G.711 both
//   ways, sealed with the space's key); a third phone of another space (a neighbour on the same
//   network) sees neither and can't be seen; an unsigned ring, one sealed with another key and a
//   replayed genuine one are all ignored.
// - chime: MENU 4 → 9 → 1 posts the phone's words as a notice; the other phone shows it.
// - daily check-in: the time passes without I'm OK, the guardian gets the alert, the phone says
//   so; 1 is I'm OK.
// - missed calls: an unanswered call shows on the phone (MENU 5), 1 calls back, MENU 8 redials,
//   3 clears them.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createSocket, type Socket } from "node:dgram";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, ProcLog } from "../procs.ts";
import { api, appSocket, type Person, type ServerTarget, signUp } from "../twoServers.ts";
import { FIRMWARE, QemuPhone } from "./wokwi.ts";

const ON = process.env.OLP_HOME_QEMU === "1";
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, "build-qemu/home");
const MAIN = fileURLToPath(new URL("../../../apps/server-selfhost/src/main.ts", import.meta.url));

let server: ServerTarget;
let port = 0;
let proc: ChildProcess | undefined;
let dataDir = "";
const serverLog = new ProcLog("selfhost-home");
const phones: QemuPhone[] = [];
const dirs: string[] = [];
let hub: Socket | undefined;
let hubPort = 0;
const lanPorts: number[] = [];
/** Frames to the intercom's control port seen on the segment (for the replay check). */
const seen: Buffer[] = [];

async function udpPort(): Promise<number> {
  const s = createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  const { port: p } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function startServer(): Promise<void> {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "olp-home-"));
  const origin = `http://h.localhost:${port}`;
  proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: origin,
      DATA_DIR: dataDir,
      OPEN_SIGNUP: "1",
      STUN_URLS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", serverLog.add);
  proc.stderr?.on("data", serverLog.add);
  const end = Date.now() + 30_000;
  while (!serverLog.text.includes("listening on")) {
    if (Date.now() > end) throw new Error(`server didn't start:\n${serverLog.text}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  server = { base: `http://127.0.0.1:${port}`, origin };
}

/** The segment: every Ethernet frame from one phone goes on to the others. */
async function startHub(): Promise<void> {
  hubPort = await udpPort();
  for (let i = 0; i < 3; i++) lanPorts.push(await udpPort());
  hub = createSocket("udp4");
  hub.on("message", (frame, from) => {
    // IPv4 (0x0800), UDP (17), to port 47100: the intercom's control lines.
    if (frame.readUInt16BE(12) === 0x0800 && frame[23] === 17 && frame.readUInt16BE(36) === 47100)
      seen.push(Buffer.from(frame));
    for (const p of lanPorts) if (p !== from.port) hub?.send(frame, p, "127.0.0.1");
  });
  await new Promise<void>((r) => hub?.bind(hubPort, "127.0.0.1", r));
}

/** Puts a frame on the segment as if from a stranger's device. */
function inject(frame: Buffer): void {
  for (const p of lanPorts) hub?.send(frame, p, "127.0.0.1");
}

/** A UDP broadcast to the intercom's control port, from 10.0.2.99. */
function broadcastFrame(payload: string): Buffer {
  const data = Buffer.from(payload);
  const udp = Buffer.alloc(8 + data.length);
  udp.writeUInt16BE(47100, 0);
  udp.writeUInt16BE(47100, 2);
  udp.writeUInt16BE(udp.length, 4);
  data.copy(udp, 8);
  const ip = Buffer.alloc(20);
  ip[0] = 0x45;
  ip.writeUInt16BE(20 + udp.length, 2);
  ip.writeUInt16BE(0x4000, 6);
  ip[8] = 64;
  ip[9] = 17;
  Buffer.from([10, 0, 2, 99]).copy(ip, 12);
  Buffer.from([255, 255, 255, 255]).copy(ip, 16);
  let sum = 0;
  for (let i = 0; i < 20; i += 2) sum += ip.readUInt16BE(i);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16);
  ip.writeUInt16BE(~sum & 0xffff, 10);
  const eth = Buffer.alloc(14);
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).copy(eth, 0);
  Buffer.from([0x02, 0, 0, 0, 0, 0xee]).copy(eth, 6);
  eth.writeUInt16BE(0x0800, 12);
  return Buffer.concat([eth, ip, udp]);
}

/** A phone on the segment (`first`: with the user network), booted and pointed at the server. */
async function bootPhone(name: string, i: number, first: boolean): Promise<QemuPhone> {
  const dir = `build-qemu-home${i}`;
  rmSync(join(FIRMWARE, dir), { recursive: true, force: true });
  cpSync(join(FIRMWARE, "build-qemu"), join(FIRMWARE, dir), {
    recursive: true,
    filter: (src) => !src.includes("/home") && !src.includes("/personas"),
  });
  dirs.push(join(FIRMWARE, dir));
  const phone = new QemuPhone(join(OUT, `${name}.log`));
  phone.buildDir = dir;
  phone.extraEnv = {
    QEMU_LAN: `${hubPort}:${lanPorts[i]}`,
    QEMU_MAC: `02:00:00:00:00:0${i + 1}`,
    ...(first ? {} : { QEMU_LAN_ONLY: "1" }),
  };
  phones.push(phone);
  phone.start();
  await phone.consoleReady(180_000);
  await phone.waitFor(/WIFI connected ip=(\S+)/, 120_000, "network");
  phone.send(`server ws://10.0.2.2:${port}`);
  return phone;
}

async function pair(phone: QemuPhone, owner: Person, name: string): Promise<string> {
  const m = await phone.waitFor(/STRIP \[PAIR (\d{3}) (\d{3})/, 180_000, "pairing code");
  const res = await api(owner, "/devices/pair", {
    body: { code: `${m[1]}${m[2]}`, name, mode: "kids" },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  await phone.waitFor(/SIGNED IN as dev_/, 180_000, "signed in");
  return res.json.id as string;
}

const shows = (phone: QemuPhone, re: RegExp, timeoutMs = 30_000) =>
  phone.waitFor(new RegExp(`STRIP \\[${re.source}`), timeoutMs, `screen ${re}`);

const keys = (phone: QemuPhone, ...k: string[]) => {
  for (const x of k) phone.send(`key ${x}`);
};

/** `audio` until the phone has sent and received `n` frames and hears the other side's 1 kHz. */
async function audioFlows(phone: QemuPhone, n = 50) {
  phone.send("audio watch 1000");
  for (let i = 0; i < 40; i++) {
    phone.send("audio");
    const m = await phone.waitFor(
      /AUDIO device=\S+ call=(\d) \S+ tx=(\d+) rx=(\d+) .*?rx1000Hz=(-?[\d.]+)/,
      15_000,
      "audio status",
    );
    const [call, tx, rx, tone] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (call === 1 && tx >= n && rx >= n && tone > -40) return { tx, rx, tone };
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`no audio both ways${phone.log.slice(-1500)}`);
}

/** HH:MM UTC a minute or two from now. */
function soon(): string {
  const now = new Date();
  const due = now.getUTCHours() * 60 + now.getUTCMinutes() + (now.getUTCSeconds() < 30 ? 1 : 2);
  const hh = String(Math.floor(due / 60) % 24).padStart(2, "0");
  return `${hh}:${String(due % 60).padStart(2, "0")}`;
}

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(OUT, { recursive: true });
  if (process.env.OLP_FW_NO_BUILD !== "1") {
    const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["build"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`qemu build failed:\n${r.stdout}\n${r.stderr}`);
  }
  await startServer();
  await startHub();
}, 1_800_000);

afterAll(async () => {
  for (const p of phones) await p.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await new Promise<void>((r) => (hub ? hub.close(() => r()) : r()));
  proc?.kill("SIGTERM");
  if (ON) writeFileSync(join(OUT, "server.log"), serverLog.text);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

describe.runIf(ON)("0.9.4 on the firmware", () => {
  it("house intercom, chime, daily check-in, missed calls, call back and redial", async () => {
    const mom = await signUp(server, "mom", "Mom");
    const ben = await signUp(server, "ben", "Ben"); // the neighbour, on the same network
    const kitchen = await bootPhone("kitchen", 0, true);
    const den = await bootPhone("den", 1, false);
    const next = await bootPhone("neighbour", 2, false);
    const kitchenId = await pair(kitchen, mom, "Kitchen");
    const denId = await pair(den, mom, "Den");
    const nextId = await pair(next, ben, "Next door");

    // --- the house intercom: off until turned on in the app; one key per space.
    const on = (who: Person, id: string, body: Record<string, unknown>) =>
      api(who, `/devices/${id}/home`, { method: "PUT", body });
    for (const [who, id] of [
      [mom, kitchenId],
      [mom, denId],
      [ben, nextId],
    ] as const) {
      expect((await on(who, id, { intercom: true })).status).toBe(200);
    }
    for (const p of [kitchen, den, next]) await p.waitFor(/INTERCOM on as /, 60_000, "on");
    // The kitchen hears the den (not the neighbour's phone): MENU 4 lists it.
    await kitchen.waitFor(/IC <- OLP1\|HELLO\|DEN/, 90_000, "den's hello");
    keys(kitchen, "menu", "4");
    await shows(kitchen, /INTERCOM\|1 DEN 0 ALL ROOMS\]/);
    keys(kitchen, "menu");
    keys(next, "menu", "4");
    await shows(next, /INTERCOM\|NO OTHER ROOMS YET\]/);
    keys(next, "menu");
    expect(kitchen.seenSince(0, /IC <- OLP1\|HELLO\|NEXT DOOR/)).toBe(false);
    expect(next.seenSince(0, /IC <- OLP1\|HELLO\|(KITCHEN|DEN)/)).toBe(false);

    // Room to room: lift, MENU 4, 1; the den rings; lift there; audio both ways.
    kitchen.send("hook up");
    keys(kitchen, "menu", "4", "1");
    await kitchen.waitFor(/IC -> OLP1\|RING\|\w+\|DEN\|KITCHEN\|call/, 30_000, "ring sent");
    await shows(den, /KITCHEN CALLING\|LIFT TO ANSWER\]/);
    await den.waitFor(/SIG ring=on/, 30_000, "ringing");
    den.send("hook up");
    await kitchen.waitFor(/IC talking with DEN/, 30_000, "kitchen talking");
    await den.waitFor(/IC talking with KITCHEN/, 30_000, "den talking");
    await shows(kitchen, /INTERCOM\|DEN\]/);
    const [a, b] = await Promise.all([audioFlows(kitchen), audioFlows(den)]);
    expect(a.rx).toBeGreaterThan(0);
    expect(b.rx).toBeGreaterThan(0);
    kitchen.send("hook down");
    await shows(den, /KITCHEN\|HUNG UP\]/);
    den.send("hook down");

    // A stranger on the network: an unsigned ring, one sealed with another key, and a genuine
    // ring replayed (captured on the segment) are all dropped.
    const ring = seen.find((f) => f.includes("OLP2|") && f.includes("OLP1|RING|"));
    expect(ring, "a genuine ring frame on the segment").toBeDefined();
    const from = den.log.length;
    inject(broadcastFrame("OLP1|RING|0000beef|DEN|STRANGER|call"));
    inject(
      broadcastFrame(
        "OLP2|1|0000aaaa|OLP1|RING|0000beef|DEN|STRANGER|call|00112233445566778899aabbccddeeff",
      ),
    );
    if (ring) inject(ring);
    await new Promise((r) => setTimeout(r, 5000));
    expect(den.seenSince(from, /CALLING\|LIFT TO ANSWER|SIG ring=on|IC <- OLP1\|RING/)).toBe(false);

    // --- the chime: the kitchen's words to every phone of the space.
    expect((await on(mom, kitchenId, { chimeText: "Dinner's ready" })).status).toBe(200);
    await kitchen.waitFor(
      /<- \{"t":"config".*"chime":\{"text":"DINNER'S READY"\}/,
      30_000,
      "chime",
    );
    keys(kitchen, "menu", "4", "9");
    await shows(kitchen, /CHIME\|DINNER'S READY\|1 SEND TO ALL PHONES\]/);
    keys(kitchen, "1");
    await kitchen.waitFor(/-> \{"t":"notice.chime"\}/, 30_000, "chime sent");
    await den.waitFor(/NOTICE \S+ \[DINNER'S READY\|\]/, 30_000, "the den shows it");
    keys(den, "back"); // clears it there

    // --- the daily check-in on the den: nobody presses 1 in time.
    const by = soon();
    expect((await on(mom, denId, { checkinBy: by })).status).toBe(200);
    await shows(den, new RegExp(`CHECK IN BY ${by}\\|PRESS 1: I'M OK\\]`), 60_000);
    await shows(den, /CHECK-IN MISSED\|PRESS 1: I'M OK\]/, 240_000);
    let inbox: { fromLabel: string; transcript: string }[] = [];
    for (let i = 0; i < 30 && !inbox.length; i++) {
      inbox = (await api(mom, "/voicemails")).json;
      if (!inbox.length) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(inbox).toMatchObject([
      { fromLabel: "Den", transcript: `Den didn't check in by ${by}.` },
    ]);
    keys(den, "1");
    await den.waitFor(/-> \{"t":"checkin.ok"\}/, 30_000, "I'm OK sent");
    await shows(den, /THANK YOU\|CHECKED IN\]/);
    // Off again, so the ready screen is the missed calls' below.
    expect((await on(mom, denId, { checkinBy: null })).status).toBe(200);

    // --- missed calls: Mom's call to the den rings out (ring time 10 s).
    expect(
      (
        await api(mom, `/devices/${denId}/voicemail`, {
          method: "PATCH",
          body: { ringSeconds: 10 },
        })
      ).status,
    ).toBeLessThan(300);
    const app = await appSocket(mom);
    app.send({ t: "call.dial", deviceId: denId });
    await den.waitFor(/STATE incoming/, 30_000, "ringing");
    for (;;) if ((await app.next("call.state")).state === "ended") break;
    await shows(den, /MISSED MOM\|MENU 5: MISSED\]/, 30_000);
    // MENU 5 with the handset up: 1 calls Mom back.
    den.send("hook up");
    keys(den, "menu", "5");
    await shows(den, /MISSED 1 OF 1\|MOM\|/);
    keys(den, "1");
    await den.waitFor(/-> \{"t":"call.back","id":"mc_/, 30_000, "call back sent");
    let ringing = await app.next("call.ringing");
    expect(ringing.from).toMatchObject({ label: "Den" });
    app.send({ t: "call.hangup", callId: ringing.callId });
    await den.waitFor(/STATE offhook/, 30_000, "back to dial tone");
    // MENU 8 redials the same (the call back).
    keys(den, "menu", "8");
    await den.waitFor(/REDIAL missed call/, 30_000, "redial");
    ringing = await app.next("call.ringing");
    expect(ringing.from).toMatchObject({ label: "Den" });
    app.send({ t: "call.hangup", callId: ringing.callId });
    // MENU 5, 3: cleared everywhere.
    keys(den, "menu", "5", "3");
    await den.waitFor(/-> \{"t":"missed.clear"\}/, 30_000, "clear sent");
    await shows(den, /NO MISSED CALLS\]/);
    keys(den, "menu");
    den.send("hook down");
    app.ws.close();
  }, 1_800_000);
});
