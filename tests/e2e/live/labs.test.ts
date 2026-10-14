// The labs firmware (firmware/labs) end to end in QEMU: real firmware, driven over its console,
// checked by its log (what the screen shows, what it sends) and by what reaches the host.
// Nothing leaves this machine.
//
//   OLP_LABS_QEMU=1 npx vitest run tests/e2e/live/labs.test.ts
//
// Env: OLP_FW_NO_BUILD=1 (reuse the last `OLP_QEMU_LABS=1 firmware/tools/qemu.sh build`),
// OLP_LABS (e.g. `intercom,den`: only those parts), OLP_LIVE_OUT (logs; default
// firmware/build-qemu-labs/e2e).
//
// - intercom: three phones on one Ethernet segment (QEMU's multicast socket; one of them has the
//   user network and hands out the addresses): they find each other, call room to room with
//   G.711 audio both ways, busy, every room (first to lift wins), a door phone, a doorbell key,
//   a chime.
// - den: one phone with a fake Home Assistant and a web server for stories: the settings page
//   (PIN, save, the token never comes back, lockout), the home panel, an `ha` key, dial-a-story,
//   and the games (Snake, Memory).
// - checkin: a phone paired to a local self-hosted server: a missed check-in becomes an alert
//   in the guardian's voicemail, then I'm OK.
// The macro pad (USB keyboard) isn't here: QEMU has no USB device for the phone (host tests
// cover its key combos).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav } from "@openloungephone/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, ProcLog } from "../procs.ts";
import { api, type ServerTarget, signUp } from "../twoServers.ts";
import { FIRMWARE, QemuPhone } from "./wokwi.ts";

const ON = process.env.OLP_LABS_QEMU === "1";
const ONLY = process.env.OLP_LABS?.split(",").map((s) => s.trim());
const want = (p: string) => ON && (!ONLY || ONLY.includes(p));
const BUILD = "build-qemu-labs";
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, BUILD, "e2e");
const MAIN = fileURLToPath(new URL("../../../apps/server-selfhost/src/main.ts", import.meta.url));

const phones: QemuPhone[] = [];
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

/** A free UDP port on 127.0.0.1. */
async function udpPort(): Promise<number> {
  const s = createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A phone with its own flash and eFuse files (a copy of the labs build's images). */
function labsPhone(name: string, env: NodeJS.ProcessEnv = {}): QemuPhone {
  const dir = `${BUILD}-${name}`;
  const to = join(FIRMWARE, dir);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const from = join(FIRMWARE, BUILD);
  const args = readFileSync(join(from, "flash_args"), "utf8");
  writeFileSync(join(to, "flash_args"), args);
  for (const [, file = ""] of args.matchAll(/^0x[0-9a-f]+\s+(\S+)$/gim)) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    copyFileSync(join(from, file), join(to, file));
  }
  dirs.push(to);
  const phone = new QemuPhone(join(OUT, `${name}.log`));
  phone.buildDir = dir;
  phone.extraEnv = env;
  phones.push(phone);
  return phone;
}

/** Boots the phone; resolves with its address once its (QEMU Ethernet) network is up. */
async function boot(phone: QemuPhone): Promise<string> {
  phone.start();
  await phone.consoleReady(180_000);
  const m = await phone.waitFor(/WIFI connected ip=(\S+)/, 120_000, "network");
  await phone.waitFor(/settings page: http:/, 60_000, "settings page");
  return m[1] ?? "";
}

/** The next STRIP line (what the screen shows) matching `re`. */
const shows = (phone: QemuPhone, re: RegExp, timeoutMs = 30_000) =>
  phone.waitFor(new RegExp(`STRIP \\[${re.source}`), timeoutMs, `screen ${re}`);

const keys = (phone: QemuPhone, ...k: string[]) => {
  for (const x of k) phone.send(`key ${x}`);
};

/** The settings page (http://olp-<room>.local on the phone's port 80, forwarded to `port`). */
class Settings {
  cookie = "";
  readonly port: number;
  constructor(port: number) {
    this.port = port;
  }
  url(path: string) {
    return `http://127.0.0.1:${this.port}${path}`;
  }
  async login(pin: number | string) {
    const r = await fetch(this.url("/api/login"), {
      method: "POST",
      body: JSON.stringify({ pin: Number(pin) }),
    });
    const set = r.headers.get("set-cookie");
    if (r.ok && set) this.cookie = set.split(";")[0] ?? "";
    return r.status;
  }
  async get() {
    const r = await fetch(this.url("/api/config"), { headers: { cookie: this.cookie } });
    return { status: r.status, text: await r.text() };
  }
  async save(cfg: unknown) {
    const r = await fetch(this.url("/api/config"), {
      method: "POST",
      headers: { cookie: this.cookie },
      body: JSON.stringify(cfg),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  }
}

/** MENU 5 (the labs screen): the settings PIN. */
async function pinOf(phone: QemuPhone): Promise<string> {
  keys(phone, "menu", "5");
  const m = await shows(phone, /LABS: [^|]*\|[^|]*\|SETTINGS PIN (\d{4})\|/);
  keys(phone, "back", "back");
  return m[1] ?? "";
}

async function configure(phone: QemuPhone, port: number, cfg: unknown): Promise<Settings> {
  const s = new Settings(port);
  expect(await s.login(await pinOf(phone))).toBe(200);
  const at = phone.cursor;
  const r = await s.save(cfg);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  await phone.waitFor(/LABS settings saved/, 30_000, "saved");
  phone.cursor = at; // the new screen may be logged before "saved" (another task)
  return s;
}

/** `re` anywhere in the log after `from` (lines from other tasks may come in any order). */
async function saw(phone: QemuPhone, from: number, re: RegExp, label: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const m = re.exec(phone.log.slice(from));
    if (m) return m;
    if (Date.now() > end)
      throw new Error(`timed out waiting for ${label}${phone.log.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

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

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(OUT, { recursive: true });
  if (process.env.OLP_FW_NO_BUILD !== "1") {
    const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["build"], {
      encoding: "utf8",
      env: { ...process.env, OLP_QEMU_LABS: "1" },
    });
    if (r.status !== 0) throw new Error(`labs qemu build failed:\n${r.stdout}\n${r.stderr}`);
  }
}, 1_800_000);

afterAll(async () => {
  for (const p of phones) await p.stop();
  for (const c of cleanups) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

describe.runIf(want("intercom"))("intercom", () => {
  it("three rooms: find each other, call with audio, busy, all rooms, door phone, chime", async () => {
    // The segment: an Ethernet hub over UDP on this machine; each phone's QEMU sends its frames
    // here from its own port, and every frame goes on to the other phones.
    const [pk, pb, pd] = [await freePort(), await freePort(), await freePort()];
    const [hubPort, ...lanPorts] = [
      await udpPort(),
      await udpPort(),
      await udpPort(),
      await udpPort(),
    ];
    const hub = createSocket("udp4");
    let frames = 0;
    hub.on("message", (frame, from) => {
      frames++;
      for (const p of lanPorts) if (p !== from.port) hub.send(frame, p, "127.0.0.1");
    });
    await new Promise<void>((r) => hub.bind(hubPort, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => hub.close(() => r())));
    const lan = (i: number) => `${hubPort}:${lanPorts[i]}`;
    // The kitchen phone has the user network (DHCP: .15, .16, .17 in boot order) and forwards
    // each phone's settings page.
    const kitchen = labsPhone("kitchen", {
      QEMU_LAN: lan(0),
      QEMU_MAC: "02:00:00:00:00:0a",
      QEMU_HOSTFWD: [
        `tcp:127.0.0.1:${pk}-:80`,
        `tcp:127.0.0.1:${pb}-10.0.2.16:80`,
        `tcp:127.0.0.1:${pd}-10.0.2.17:80`,
      ].join(" "),
    });
    const lanOnly = (i: number, mac: string) => ({
      QEMU_LAN: lan(i),
      QEMU_LAN_ONLY: "1",
      QEMU_MAC: mac,
    });
    const kids = labsPhone("kids", lanOnly(1, "02:00:00:00:00:0b"));
    const door = labsPhone("door", lanOnly(2, "02:00:00:00:00:0c"));
    expect(await boot(kitchen)).toBe("10.0.2.15");
    expect(await boot(kids)).toBe("10.0.2.16");
    expect(await boot(door)).toBe("10.0.2.17");

    await configure(kitchen, pk, {
      name: "Kitchen",
      mode: "intercom",
      keys: [
        { key: "1", action: "intercom", target: "Kids room" },
        { key: "2", action: "all" },
        { key: "3", action: "chime", target: "Dinner's ready" },
        { key: "4", action: "doorbell", target: "Kids room" },
      ],
    });
    await configure(kids, pb, {
      name: "Kids room",
      mode: "intercom",
      keys: [{ key: "1", action: "intercom", target: "Kitchen" }],
    });
    const doorSettings = await configure(door, pd, {
      name: "Front door",
      mode: "doorbell",
      keys: [{ key: "2", action: "intercom", target: "Kids room" }],
    });

    // HELLO: each room sees the other two (every 20 s; peers listed on the settings page too).
    await shows(kitchen, /KITCHEN\|2 ROOMS NEARBY\]/, 90_000);
    await shows(kids, /KIDS ROOM\|2 ROOMS NEARBY\]/, 90_000);
    await shows(door, /FRONT DOOR\|PRESS ANY KEY TO RING\]/, 30_000);
    let peers: string[] = [];
    for (let i = 0; i < 30 && peers.length < 2; i++) {
      peers = JSON.parse((await doorSettings.get()).text).peers;
      if (peers.length < 2) await new Promise((r) => setTimeout(r, 2000));
    }
    expect(peers.sort()).toEqual(["KIDS ROOM", "KITCHEN"]); // the new names only

    // Room to room: lift, press, the other room rings; lift there to answer; audio both ways.
    kitchen.send("hook up");
    keys(kitchen, "1");
    await kitchen.waitFor(/IC -> OLP1\|RING\|\w+\|KIDS ROOM\|KITCHEN\|call/, 30_000, "ring sent");
    await shows(kitchen, /CALLING\|KIDS ROOM\]/);
    await kids.waitFor(/IC <- OLP1\|RING\|\w+\|KIDS ROOM\|KITCHEN\|call/, 30_000, "ring heard");
    await shows(kids, /KITCHEN\|LIFT TO ANSWER\]/);
    await kids.waitFor(/SIG ring=on/, 30_000, "ringing");
    expect(door.seenSince(0, /IC <- OLP1\|RING\|\w+\|KIDS ROOM/)).toBe(true); // heard, not for it
    kids.send("hook up");
    await kids.waitFor(/IC -> OLP1\|ANSWER\|/, 30_000, "answer");
    await kids.waitFor(/IC talking with KITCHEN/, 30_000, "kids talking");
    await kitchen.waitFor(/IC talking with KIDS ROOM/, 30_000, "kitchen talking");
    await shows(kitchen, /INTERCOM\|KIDS ROOM\]/);
    const [a, b] = await Promise.all([audioFlows(kitchen), audioFlows(kids)]);
    expect(a.rx).toBeGreaterThan(0);
    expect(b.rx).toBeGreaterThan(0);

    // Busy: the door phone calls the kids' room while it talks.
    door.send("hook up");
    keys(door, "2");
    await kids.waitFor(/IC -> OLP1\|BUSY\|\w+\|KIDS ROOM/, 30_000, "busy sent");
    await shows(door, /KIDS ROOM\|IS BUSY\]/);
    door.send("hook down");

    // Hang up: BYE; the other room hears it; both stop their audio; the kitchen phone is back
    // on the hook (it was lifted to call).
    let k = kitchen.log.length;
    let c = kids.log.length;
    kitchen.send("hook down");
    await kitchen.waitFor(/IC -> OLP1\|BYE\|/, 30_000, "bye");
    await shows(kids, /KITCHEN\|HUNG UP\]/);
    await saw(kitchen, k, /call media off/, "kitchen media off");
    await saw(kids, c, /call media off/, "kids media off");
    kids.send("hook down");
    kitchen.send("status");
    await kitchen.waitFor(/STATUS state=idle /, 15_000, "kitchen idle after hanging up");

    // Every room: both ring, the first to lift answers, the other stops.
    kitchen.send("hook up");
    keys(kitchen, "2");
    await kitchen.waitFor(/IC -> OLP1\|RING\|\w+\|\*\|KITCHEN\|call/, 30_000, "ring all");
    await Promise.all([
      shows(kids, /KITCHEN\|LIFT TO ANSWER\]/),
      shows(door, /KITCHEN\|LIFT TO ANSWER\]/),
    ]);
    c = kids.log.length;
    door.send("hook up");
    await kitchen.waitFor(/IC talking with FRONT DOOR/, 30_000, "first to lift");
    await shows(kids, /KITCHEN\|ANSWERED\]/);
    await saw(kids, c, /SIG ring=off/, "kids stops ringing");
    await audioFlows(door);
    k = kitchen.log.length;
    door.send("hook down");
    await shows(kitchen, /FRONT DOOR\|HUNG UP\]/);
    await saw(kitchen, k, /call media off/, "media off");
    kitchen.send("hook down");

    // A door phone (mode doorbell): any key rings the house with the handset down; whoever lifts
    // talks to it; the visitor lifts and hangs up.
    keys(door, "5");
    await door.waitFor(/IC -> OLP1\|RING\|\w+\|\*\|FRONT DOOR\|door/, 30_000, "doorbell");
    await shows(door, /RINGING THE HOUSE\|LIFT THE HANDSET TO TALK\]/);
    await Promise.all([
      shows(kitchen, /FRONT DOOR\|LIFT TO ANSWER\]/),
      shows(kids, /FRONT DOOR\|LIFT TO ANSWER\]/),
    ]);
    kids.send("hook up");
    await door.waitFor(/IC talking with KIDS ROOM/, 30_000, "door answered");
    await shows(kitchen, /FRONT DOOR\|ANSWERED\]/);
    door.send("hook up");
    await audioFlows(kids);
    door.send("hook down");
    await shows(kids, /FRONT DOOR\|HUNG UP\]/);
    kids.send("hook down");

    // A doorbell key (target one room), handset down; BACK ends it.
    const d = door.log.length;
    keys(kitchen, "4");
    await kitchen.waitFor(/IC -> OLP1\|RING\|\w+\|KIDS ROOM\|KITCHEN\|door/, 30_000, "door key");
    await shows(kids, /KITCHEN\|LIFT TO ANSWER\]/);
    await saw(door, d, /IC <- OLP1\|RING\|\w+\|KIDS ROOM\|KITCHEN\|door/, "door hears it");
    expect(door.seenSince(d, /LIFT TO ANSWER|SIG ring=on/)).toBe(false); // not for the door
    kids.send("hook up");
    await kitchen.waitFor(/IC talking with KIDS ROOM/, 30_000, "door key answered");
    keys(kitchen, "back");
    await kitchen.waitFor(/IC -> OLP1\|BYE\|/, 30_000, "back ends it");
    await shows(kids, /KITCHEN\|HUNG UP\]/);
    kids.send("hook down");

    // A chime: every other phone beeps and shows the words.
    keys(kitchen, "3");
    await kitchen.waitFor(/IC -> OLP1\|CHIME\|KITCHEN\|Dinner's ready/, 30_000, "chime");
    for (const p of [kids, door]) {
      await p.waitFor(/IC chime \[Dinner's ready\|KITCHEN\]: beep/, 30_000, "chime heard");
      await shows(p, /Dinner's ready\|KITCHEN\]/);
    }
    writeFileSync(join(OUT, "lan.txt"), `${frames} frames through the hub\n`);
  }, 1_500_000);
});

describe.runIf(want("den"))("den", () => {
  const TOKEN = "ha-secret-token-6f1c";
  const ha: { method: string; url: string; auth: string; body: string }[] = [];
  let garage = "open";
  let host: Server | undefined;
  let hostPort = 0;
  const story = encodeWav(
    new Float32Array(8000 * 8).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 8000)),
    8000,
  );

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let b = "";
      req.on("data", (d) => {
        b += d;
      });
      req.on("end", () => resolve(b));
    });

  beforeAll(async () => {
    if (!ON) return;
    hostPort = await freePort();
    // A fake Home Assistant (REST API) and a web server with a story, on this machine (10.0.2.2).
    host = createServer(async (req, res) => {
      const body = await read(req);
      if (req.url?.startsWith("/api/")) {
        ha.push({
          method: req.method ?? "",
          url: req.url,
          auth: req.headers.authorization ?? "",
          body,
        });
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401).end();
        } else if (req.url === "/api/states/cover.garage_door") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ entity_id: "cover.garage_door", state: garage }));
        } else if (req.method === "POST" && req.url === "/api/services/scene/turn_on") {
          res.writeHead(200, { "content-type": "application/json" }).end("[]");
        } else res.writeHead(404).end();
      } else if (req.url === "/stories/bear.wav") {
        res.writeHead(200, { "content-type": "audio/wav", "content-length": story.byteLength });
        res.end(Buffer.from(story.buffer, story.byteOffset, story.byteLength));
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => host?.listen(hostPort, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => host?.close(() => r())));
  });

  it("settings page, home panel, an ha key, a story, and the games", async () => {
    const port = await freePort();
    const den = labsPhone("den", { QEMU_HOSTFWD: `tcp:127.0.0.1:${port}-:80` });
    await boot(den);
    const s = new Settings(port);

    // The settings page: the page, then nothing without the PIN.
    const page = await fetch(s.url("/"));
    expect(await page.text()).toContain("Open Lounge Phone labs");
    expect((await s.get()).status).toBe(401);
    expect((await s.save({ name: "x" })).status).toBe(401);
    const pin = await pinOf(den);
    expect(await s.login(pin === "1000" ? "1001" : "1000")).toBe(403);
    expect(await s.login(pin)).toBe(200);
    const base = `http://10.0.2.2:${hostPort}`;
    const cfg = {
      name: "Den",
      mode: "home",
      keys: [
        {
          key: "4",
          action: "ha",
          service: "scene.turn_on",
          target: "scene.night",
          label: "Lights off",
        },
        { key: "5", action: "story", url: `${base}/stories/bear.wav`, label: "Bear story" },
      ],
      ha: { url: `${base}/`, token: TOKEN, status: "cover.garage_door", status_label: "Garage" },
    };
    let saved = await s.save(cfg);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toEqual({ ok: true });
    // The token is write-only: never in what the page reads back, and a blank one keeps it.
    let got = await s.get();
    expect(got.text).not.toContain(TOKEN);
    const c = JSON.parse(got.text);
    expect(c).toMatchObject({ name: "DEN", mode: "home", ha: { token_set: true } });
    expect(c.keys).toEqual([
      {
        key: "4",
        action: "ha",
        label: "LIGHTS OFF",
        target: "scene.night",
        service: "scene.turn_on",
      },
      { key: "5", action: "story", label: "BEAR STORY", url: `${base}/stories/bear.wav` },
    ]);
    saved = await s.save({ ...cfg, ha: { ...cfg.ha, token: "" } });
    expect(saved.status).toBe(200);
    got = await s.get();
    expect(got.text).not.toContain(TOKEN);
    expect(JSON.parse(got.text).ha.token_set).toBe(true);
    expect(
      (await s.save({ ...cfg, keys: [{ key: "1", action: "story", url: "ftp://x" }] })).json,
    ).toEqual({ error: "key 1: a story needs an http(s) url" });

    // The home panel: polls the status entity with the token and shows it.
    await shows(den, /DEN\|GARAGE: OPEN\]/, 60_000);
    const poll = ha.find((r) => r.url === "/api/states/cover.garage_door");
    expect(poll).toMatchObject({ method: "GET", auth: `Bearer ${TOKEN}` });
    garage = "closed";
    await shows(den, /DEN\|GARAGE: CLOSED\]/, 90_000); // the next poll, a minute later

    // An ha key calls the service with the bearer token.
    keys(den, "4");
    await shows(den, /LIGHTS OFF\|DONE\]/, 30_000);
    expect(ha.filter((r) => r.method === "POST")).toEqual([
      {
        method: "POST",
        url: "/api/services/scene/turn_on",
        auth: `Bearer ${TOKEN}`,
        body: '{"entity_id":"scene.night"}',
      },
    ]);

    // Dial-a-story: lift, press: it downloads and plays in the earpiece to the end.
    den.send("hook up");
    keys(den, "5");
    await den.waitFor(/download: HTTP 200, 128044 bytes/, 60_000, "story downloaded");
    await shows(den, /NOW PLAYING\|BEAR STORY\|00:00 OF 00:08\|1 AGAIN 2 NEXT\]/);
    await shows(den, /NOW PLAYING\|BEAR STORY\|00:01 OF 00:08/, 30_000); // the clock moves
    // The (test) earpiece hears the story's 440 Hz (silence reads -100 dBFS).
    den.send("audio watch 440");
    let ear = -100;
    for (let i = 0; i < 6 && ear < -45; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      den.send("audio");
      const m = await den.waitFor(/earpiece=-?[\d.]+ earpiece440Hz=(-?[\d.]+)/, 15_000, "ear");
      ear = Number(m[1]);
    }
    expect(ear).toBeGreaterThan(-45);
    // 1 plays it again from the start.
    keys(den, "1");
    await shows(den, /NOW PLAYING\|BEAR STORY\|00:00 OF 00:08/, 30_000);
    await den.waitFor(/played 64000 samples/, 30_000, "played to the end");
    await shows(den, /THE END\|BEAR STORY\]/);
    // Press first, then lift (within 15 s): it plays. 2 = next (there is none): the end.
    den.send("hook down");
    keys(den, "5");
    await shows(den, /BEAR STORY\|LIFT THE HANDSET\]/);
    den.send("hook up");
    await shows(den, /NOW PLAYING\|BEAR STORY\|00:00 OF/, 60_000);
    keys(den, "2");
    await shows(den, /THE END\|BEAR STORY\]/);
    // BACK stops it (hang up and lift again first: THE END holds the keys for 3 s).
    den.send("hook down");
    den.send("hook up");
    keys(den, "5");
    await shows(den, /NOW PLAYING\|BEAR STORY\|00:00 OF/, 60_000);
    const before = den.cursor;
    keys(den, "back");
    const after = await den.waitFor(/STRIP \[([^\]]*)\]/, 30_000, "the screen after BACK");
    expect(after[1]).not.toMatch(/NOW PLAYING|THE END/);
    await new Promise((r) => setTimeout(r, 10_000)); // longer than the story
    expect(den.seenSince(before, /played \d+ samples|00:0[2-7] OF 00:08/)).toBe(false);
    den.send("hook down");

    // Games: MENU ten times. 1 Snake: it moves on its own and hits the wall.
    keys(den, ...Array(10).fill("menu"));
    await den.waitFor(/snake: games menu/, 30_000, "games menu");
    keys(den, "1");
    await den.waitFor(/snake: start \(29 x 12\)/, 30_000, "snake start");
    const m1 = await den.waitFor(/snake: move (\d+),(\d+)/, 10_000, "move");
    const m2 = await den.waitFor(/snake: move (\d+),(\d+)/, 10_000, "move again");
    expect(Number(m2[1])).toBe(Number(m1[1]) + 1); // right, one cell a tick
    keys(den, "3"); // up
    const m3 = await den.waitFor(/snake: move (\d+),(\d+)/, 10_000, "turned");
    expect(Number(m3[2])).toBeLessThan(Number(m2[2]));
    await den.waitFor(/snake: game over, score \d+/, 60_000, "game over");
    keys(den, "menu"); // again
    await den.waitFor(/snake: start \(29 x 12\)/, 30_000, "snake again");
    keys(den, "back"); // back to the games menu
    await den.waitFor(/snake: games menu/, 30_000, "games menu again");

    // 2 Memory: watch, key it back (next round, one more digit), then a wrong one: game over.
    keys(den, "2");
    await den.waitFor(/snake: memory start/, 30_000, "memory");
    const d1 = await den.waitFor(/snake: memory watch 1 of 1: (\d)/, 30_000, "digit 1");
    await den.waitFor(/snake: memory your turn/, 30_000, "your turn");
    keys(den, d1[1] ?? "");
    await den.waitFor(/snake: memory round 1 right/, 30_000, "round 1 right");
    const r2a = await den.waitFor(/snake: memory watch 1 of 2: (\d)/, 30_000, "round 2 digit 1");
    expect(r2a[1]).toBe(d1[1]); // the same row, one longer
    const r2b = await den.waitFor(/snake: memory watch 2 of 2: (\d)/, 30_000, "round 2 digit 2");
    await den.waitFor(/snake: memory your turn/, 30_000, "your turn 2");
    keys(den, r2a[1] ?? "", String((Number(r2b[1]) + 1) % 10));
    await den.waitFor(/snake: memory over, score 1/, 30_000, "memory over");
    keys(den, "back", "back");
    await den.waitFor(/snake: stop/, 30_000, "games closed");

    // Five wrong PINs lock the page for a minute (even the right one).
    for (let i = 0; i < 5; i++) expect(await s.login(pin === "1000" ? "1001" : "1000")).toBe(403);
    expect(await s.login(pin)).toBe(429);
  }, 1_200_000);
});

describe.runIf(want("checkin"))("checkin", () => {
  let proc: ChildProcess | undefined;
  let dataDir = "";
  let server: ServerTarget;
  let port = 0;
  const serverLog = new ProcLog("selfhost-labs");

  beforeAll(async () => {
    if (!ON) return;
    port = await freePort();
    dataDir = mkdtempSync(join(tmpdir(), "olp-labs-"));
    const origin = `http://l.localhost:${port}`;
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
    cleanups.push(() => {
      proc?.kill("SIGTERM");
      writeFileSync(join(OUT, "server.log"), serverLog.text);
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    });
    const end = Date.now() + 30_000;
    while (!serverLog.text.includes("listening on")) {
      if (Date.now() > end) throw new Error(`server didn't start:\n${serverLog.text}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    server = { base: `http://127.0.0.1:${port}`, origin };
  }, 60_000);

  it("a missed check-in tells the guardian (an alert in their voicemail), then I'm OK", async () => {
    const mom = await signUp(server, "mom", "Mom");
    const web = await freePort();
    const phone = labsPhone("grandma", { QEMU_HOSTFWD: `tcp:127.0.0.1:${web}-:80` });
    await boot(phone);
    phone.send(`server ws://10.0.2.2:${port}`);
    const code = await phone.waitFor(/STRIP \[PAIR (\d{3}) (\d{3})/, 180_000, "pairing code");
    const paired = await api(mom, "/devices/pair", {
      body: { code: `${code[1]}${code[2]}`, name: "Grandma", mode: "kids" },
    });
    expect(paired.status, JSON.stringify(paired.json)).toBe(201);
    await phone.waitFor(/SIGNED IN as dev_/, 180_000, "signed in");

    // Due in a minute or two (the space's clock is UTC; the phone's comes from the server).
    const now = new Date();
    const due = now.getUTCHours() * 60 + now.getUTCMinutes() + (now.getUTCSeconds() < 30 ? 1 : 2);
    const by = `${String(Math.floor(due / 60) % 24).padStart(2, "0")}:${String(due % 60).padStart(2, "0")}`;
    await configure(phone, web, { name: "Grandma", mode: "checkin", checkin: { by } });
    await shows(phone, /GOOD MORNING\|PRESS 1: I'M OK\]/, 60_000);
    // Nobody presses 1: the phone tells the server once the time has passed.
    await phone.waitFor(
      new RegExp(`-> \\{"t":"checkin.missed","by":"${by}"\\}`),
      240_000,
      "checkin.missed sent",
    );
    await shows(phone, /FAMILY WAS TOLD\|PRESS 1: I'M OK\]/);
    let inbox: { fromLabel: string; transcript: string }[] = [];
    for (let i = 0; i < 30 && !inbox.length; i++) {
      inbox = (await api(mom, "/voicemails")).json;
      if (!inbox.length) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(inbox).toMatchObject([
      { fromLabel: "Grandma", transcript: `Grandma didn't check in by ${by}.`, mime: "audio/wav" },
    ]);
    // I'm OK (key 1), late: sent, and the screen says so.
    keys(phone, "1");
    await phone.waitFor(/-> \{"t":"checkin.ok"\}/, 30_000, "checkin.ok sent");
    await shows(phone, /THANK YOU\|CHECKED IN\]/);
    await shows(phone, /CHECKED IN\|SEE YOU TOMORROW\]/, 30_000);
    // One alert a day.
    expect((await api(mom, "/voicemails")).json).toHaveLength(1);
  }, 900_000);
});
