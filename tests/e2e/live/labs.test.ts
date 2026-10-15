// The labs firmware (firmware/labs) end to end in QEMU: real firmware, driven over its console,
// checked by its log (what the screen shows, what it sends) and by what reaches the host.
// Nothing leaves this machine.
//
//   OLP_LABS_QEMU=1 npx vitest run tests/e2e/live/labs.test.ts
//
// Env: OLP_FW_NO_BUILD=1 (reuse the last `OLP_QEMU_LABS=1 firmware/tools/qemu.sh build`),
// OLP_LABS (e.g. `den`: only those parts), OLP_LIVE_OUT (logs; default
// firmware/build-qemu-labs/e2e).
//
// - den: one phone with a fake Home Assistant and a web server for stories: the settings page
//   (PIN, save, the token never comes back, lockout), the home panel, an `ha` key, dial-a-story,
//   and the games (Snake, Memory).
// The house intercom and the daily check-in moved into the phone firmware (0.9.4): their test is
// tests/e2e/live/home.test.ts (the labs build reuses them).
// The macro pad (USB keyboard) isn't here: QEMU has no USB device for the phone (host tests
// cover its key combos).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { encodeWav } from "@openloungephone/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "../procs.ts";
import { FIRMWARE, QemuPhone } from "./wokwi.ts";

const ON = process.env.OLP_LABS_QEMU === "1";
const ONLY = process.env.OLP_LABS?.split(",").map((s) => s.trim());
const want = (p: string) => ON && (!ONLY || ONLY.includes(p));
const BUILD = "build-qemu-labs";
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, BUILD, "e2e");

const phones: QemuPhone[] = [];
const dirs: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

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

/** MENU 4 (the labs screen): the settings PIN. */
async function pinOf(phone: QemuPhone): Promise<string> {
  keys(phone, "menu", "4");
  const m = await shows(phone, /LABS: [^|]*\|[^|]*\|SETTINGS PIN (\d{4})\|/);
  keys(phone, "back", "back");
  return m[1] ?? "";
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
