// Personas on the firmware, end to end and entirely local: a self-hosted server on this machine
// and phones running the real firmware in QEMU (no Wi-Fi radio, no codec: the console drives
// keys and the hook, and the phone's log says what its screen shows). Nothing leaves the machine.
//
//   OLP_FIRMWARE_LOCAL=1 npx vitest run tests/e2e/live/personas.test.ts
//
// Env: OLP_FW_NO_BUILD=1 (reuse the last `firmware/tools/qemu.sh build`), OLP_PERSONAS (e.g.
// `kid,lounge`: only those), OLP_LIVE_OUT (logs; default firmware/build-qemu/personas).
//
// - kid: a kids' phone in a home; MENU 3 asks for a second press before the setup network.
// - office: a personal phone in a team space; MENU 6 dials a colleague's extension; a no-answer
//   message is played on the phone (MENU 2 1) and marked heard.
// - lounge: two Lounge phones in one space; two people take one each (code + key proof),
//   "open to chat" shows as "who's here" on the free phone, log out forgets the person.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeWav } from "@openloungephone/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, ProcLog } from "../procs.ts";
import { api, appSocket, type Person, type ServerTarget, signUp } from "../twoServers.ts";
import { FIRMWARE, QemuPhone } from "./wokwi.ts";

const ON = process.env.OLP_FIRMWARE_LOCAL === "1";
const ONLY = process.env.OLP_PERSONAS?.split(",").map((s) => s.trim());
const want = (p: string) => ON && (!ONLY || ONLY.includes(p));
const OUT = process.env.OLP_LIVE_OUT ?? join(FIRMWARE, "build-qemu/personas");
const MAIN = fileURLToPath(new URL("../../../apps/server-selfhost/src/main.ts", import.meta.url));

let server: ServerTarget;
let port = 0;
let proc: ChildProcess | undefined;
let dataDir = "";
const serverLog = new ProcLog("selfhost-personas");
const phones: QemuPhone[] = [];
let phoneCount = 0;

async function startServer(): Promise<void> {
  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "olp-personas-"));
  const origin = `http://p.localhost:${port}`;
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
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`server didn't start:\n${serverLog.text}`)),
      20_000,
    );
    const check = () => {
      if (serverLog.text.includes("listening on")) {
        clearTimeout(t);
        resolve();
      }
    };
    proc?.stdout?.on("data", check);
    proc?.stderr?.on("data", check);
  });
  server = { base: `http://127.0.0.1:${port}`, origin };
}

/** A fresh phone: its own copy of the QEMU build (flash + eFuse), booted, pointed at our server. */
async function bootPhone(name: string): Promise<QemuPhone> {
  const dir = `build-qemu-p${++phoneCount}`;
  rmSync(join(FIRMWARE, dir), { recursive: true, force: true });
  cpSync(join(FIRMWARE, "build-qemu"), join(FIRMWARE, dir), {
    recursive: true,
    filter: (src) => !src.includes("/personas"),
  });
  const phone = new QemuPhone(join(OUT, `${name}.log`));
  phone.buildDir = dir;
  phones.push(phone);
  phone.start();
  await phone.consoleReady(120_000);
  // The phone reaches this machine's loopback as 10.0.2.2 (QEMU's user network).
  phone.send(`server ws://10.0.2.2:${port}`);
  return phone;
}

/** Pairs a phone that shows its code into `owner`'s active space as `mode`. */
async function pair(
  phone: QemuPhone,
  owner: Person,
  mode: "kids" | "personal" | "lounge",
  name: string,
) {
  const m = await phone.waitFor(/STRIP \[PAIR (\d{3}) (\d{3})/, 180_000, "pairing code");
  const code = `${m[1]}${m[2]}`;
  const res = await api(owner, "/devices/pair", {
    body: { code, name, ...(mode === "personal" ? { forMe: true } : { mode }) },
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  await phone.waitFor(/SIGNED IN as dev_/, 180_000, "signed in");
  return res.json.id as string;
}

/** The phone's screen, from its log: the next STRIP line matching `re`. */
const shows = (phone: QemuPhone, re: RegExp, timeoutMs = 30_000) =>
  phone.waitFor(new RegExp(`STRIP \\[${re.source}`), timeoutMs, `screen ${re}`);

const keys = (phone: QemuPhone, ...k: string[]) => {
  for (const x of k) phone.send(`key ${x}`);
};

beforeAll(async () => {
  if (!ON) return;
  mkdirSync(OUT, { recursive: true });
  if (process.env.OLP_FW_NO_BUILD !== "1") {
    const r = spawnSync(join(FIRMWARE, "tools/qemu.sh"), ["image"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`qemu build failed:\n${r.stdout}\n${r.stderr}`);
  }
  await startServer();
}, 900_000);

afterAll(async () => {
  for (const p of phones) await p.stop();
  for (let i = 1; i <= phoneCount; i++) {
    rmSync(join(FIRMWARE, `build-qemu-p${i}`), { recursive: true, force: true });
  }
  proc?.kill("SIGTERM");
  if (ON) writeFileSync(join(OUT, "server.log"), serverLog.text);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(want("kid"))("kid", () => {
  it("a kids' phone: the trust line, the key map, and MENU 3 needs a second press", async () => {
    const mom = await signUp(server, "mom", "Mom");
    const phone = await bootPhone("kid");
    await pair(phone, mom, "kids", "Lily");
    await shows(phone, /READY[^|]*\|KIDS: /, 60_000);
    phone.send("hook up");
    await phone.waitFor(/KEYS \d+\|KIDS: [^|]*\|PRESS A KEY TO CALL\|Mom/, 30_000, "key map");
    phone.send("hook down");
    keys(phone, "menu", "3");
    await shows(phone, /NETWORK\|[^\]]*\|1 CHANGE\]/);
    keys(phone, "1");
    await shows(phone, /NETWORK\|[^\]]*\|PRESS 1 AGAIN\]/);
    keys(phone, "back", "back");
  }, 600_000);
});

describe.runIf(want("office"))("office", () => {
  it("a desk phone in a team space: extension dialing, and voicemail played on the phone", async () => {
    const jesse = await signUp(server, "jesse", "Jesse");
    const bob = await signUp(server, "bob", "Bob");
    // An office space: Jesse owns it, Bob joins with an invite.
    const space = await api(jesse, "/spaces", { body: { name: "Office", type: "team" } });
    expect(space.status, JSON.stringify(space.json)).toBe(201);
    const office = { ...jesse, householdId: space.json.household?.id ?? space.json.id };
    const sw = await api(jesse, "/me/household", {
      method: "PUT",
      body: { householdId: office.householdId },
    });
    expect(sw.status, JSON.stringify(sw.json)).toBeLessThan(300);
    const invite = await api(jesse, "/invites", { body: { name: "Bob", role: "contact" } });
    const accepted = await api(bob, "/invites/accept", { body: { token: invite.json.token } });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
    const bobUser = accepted.json.user.id as string;
    const bobOffice: Person = { ...bob, householdId: office.householdId };
    const ext = await api(jesse, "/extensions/204", {
      method: "PUT",
      body: { kind: "user", targetId: bobUser },
    });
    expect(ext.status, JSON.stringify(ext.json)).toBe(204);

    const phone = await bootPhone("office");
    await pair(phone, jesse, "personal", "Desk");
    await shows(phone, /READY[^|]*\|JESSE'S PHONE/, 60_000);
    // MENU shows 6 EXT in a space with extensions.
    keys(phone, "menu");
    await shows(phone, /MENU\|[^\]]*6 EXT/);
    keys(phone, "menu");
    // MENU 6 without the handset: lift first.
    keys(phone, "menu", "6", "2", "0", "4", "menu");
    await shows(phone, /LIFT THE HANDSET/);
    const bApp = await appSocket(bobOffice);
    phone.send("hook up");
    await phone.waitFor(/KEYS /, 30_000, "key map");
    keys(phone, "menu", "6", "2", "0", "4");
    await shows(phone, /EXT 204_/);
    keys(phone, "menu");
    const ring = await bApp.next("call.ringing", 30_000);
    expect((ring.from as { label?: string }).label).toBeTruthy();
    phone.send("hook down");
    await bApp.next("call.state", 30_000);

    // Bob calls Jesse; nobody answers; Bob leaves a WAV message (what the app now records).
    const bHome = await appSocket(bobOffice);
    const me = await api(jesse, "/me");
    const jesseUser = (me.json.user?.id ?? me.json.id) as string;
    bHome.send({ t: "call.user", userId: jesseUser });
    let offer: { ticket: string } | undefined;
    for (let i = 0; i < 20 && !offer; i++) {
      const s = await bHome.next("call.state", 90_000);
      if (s.state === "ended") offer = s.voicemail as { ticket: string } | undefined;
    }
    expect(offer?.ticket).toBeTruthy();
    const tone = new Float32Array(8000 * 2).map(
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 8000),
    );
    const wav = encodeWav(tone, 8000);
    const up = await fetch(
      `${server.base}/api/vm/message?ticket=${encodeURIComponent(offer?.ticket ?? "")}&durationMs=2000`,
      {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Blob([wav.buffer as ArrayBuffer]),
      },
    );
    expect(up.status).toBe(201);
    await shows(phone, /MISSED BOB/, 60_000);
    keys(phone, "menu", "2");
    await shows(phone, /1 NEW VOICEMAIL\|1 PLAY 3 CLEAR\]/);
    phone.send("hook up");
    keys(phone, "menu", "2", "1");
    await shows(phone, /MESSAGE 1 OF 1\|BOB/, 60_000);
    await phone.waitFor(/download: HTTP 200/, 60_000, "download");
    await shows(phone, /NO MORE MESSAGES/, 60_000);
    phone.send("hook down");
    // Heard: the missed line goes away.
    await shows(phone, /READY[^|]*\|JESSE'S PHONE\]/, 60_000);
    bApp.ws.close();
    bHome.ws.close();
  }, 900_000);
});

describe.runIf(want("lounge"))("lounge", () => {
  it("two Lounge phones: takeover with the key proof, who's here, log out forgets", async () => {
    const ana = await signUp(server, "ana", "Ana");
    const ben = await signUp(server, "ben", "Ben");
    const invite = await api(ana, "/invites", { body: { name: "Ben", role: "contact" } });
    const accepted = await api(ben, "/invites/accept", { body: { token: invite.json.token } });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201);
    const benHere: Person = { ...ben, householdId: ana.householdId };
    const set = await api(ana, "/lounge/settings", {
      method: "PUT",
      body: { whosHere: true },
    });
    expect(set.status, JSON.stringify(set.json)).toBe(204);

    const [lobby, patio] = await Promise.all([
      bootPhone("lounge-lobby"),
      bootPhone("lounge-patio"),
    ]);
    await Promise.all([pair(lobby, ana, "lounge", "Lobby"), pair(patio, ana, "lounge", "Patio")]);
    await Promise.all([
      lobby.waitFor(/LOUNGE code shown \[SCAN TO USE\|THIS PHONE\]/, 60_000, "lobby code"),
      patio.waitFor(/LOUNGE code shown \[SCAN TO USE\|THIS PHONE\]/, 60_000, "patio code"),
    ]);

    /** Scans the phone's code in the app and presses the key the phone asks for. */
    async function takeOver(phone: QemuPhone, who: Person) {
      phone.send("lounge");
      const m = await phone.waitFor(
        /LOUNGE on=1 .*url=\S+\/lounge#(dev_[\w-]+)\.([\w-]+)/,
        30_000,
        "code",
      );
      const app = await appSocket(who);
      app.send({ t: "lounge.claim", deviceId: m[1], nonce: m[2] });
      const k = await phone.waitFor(/LOUNGE challenge: press key (\d+)/, 30_000, "challenge");
      await shows(phone, /PRESS KEY \d\|TO START/);
      const index = Number(k[1]);
      keys(phone, String(index === 9 ? 0 : index + 1));
      await phone.waitFor(/LOUNGE session started/, 30_000, "session");
      return app;
    }

    const anaApp = await takeOver(lobby, ana);
    await shows(lobby, /HI ANA\|MENU = OPTIONS/);
    const benApp = await takeOver(patio, benHere);
    await shows(patio, /HI BEN/);
    // Ben opens up to chat from the phone (MENU 5).
    keys(patio, "menu", "5");
    await shows(patio, /HI BEN\|OPEN TO CHAT/);
    // Ana logs out at the lobby phone (MENU 8): it forgets her and shows who's here.
    keys(lobby, "menu", "8");
    await shows(lobby, /SIGNED OUT\|SEE YOU/, 30_000);
    await lobby.waitFor(/LOUNGE code shown \[SCAN TO USE\|HERE: BEN\]/, 60_000, "who's here");
    // The patio phone's MENU offers 8 LOG OUT while Ben is on it.
    keys(patio, "menu");
    await shows(patio, /MENU\|[^\]]*8 LOG OUT/);
    keys(patio, "back");
    anaApp.ws.close();
    benApp.ws.close();
  }, 900_000);
});
