// Run it offline: a self-hosted server on this machine behind a local HTTPS front with a
// self-signed certificate, reached by a home-network name (olp.home.arpa), and two browsers that
// may reach ONLY that server. Every request to any other host is refused and recorded; the
// browser can't resolve any other name; the server has no STUN or TURN, so WebRTC uses host
// candidates only (docs/site/how-to/run-it-offline.md).
//
//   OLP_OFFLINE_E2E=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=…] \
//     [OLP_OFFLINE_SHOTS=dir] npx vitest run tests/e2e/live/offline.test.ts
//
// OLP_ADDON_NO_BUILD=1 reuses the last web build.
//
// - first-run setup from the printed link, with a passkey (virtual authenticator) and the
//   recovery code; sign out and back in with the passkey;
// - a second person joins by invite (passkey too);
// - a browser phone is paired as the first person's own phone through the app;
// - the second person calls the first: the phone rings and answers; WebRTC reaches `connected`
//   on host candidates and audio packets flow both ways;
// - the phone calls the second person back from its key;
// - an unanswered call leaves a voicemail, which plays back.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttps, type Server } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { freePort, ProcLog, reportLogs } from "../procs.ts";
import { api, type ServerTarget } from "../twoServers.ts";
import {
  CHROMIUM_ARGS,
  Companion,
  Phone,
  pcConnected,
  selectedCandidateType,
  until,
} from "./browser.ts";

const ON = process.env.OLP_OFFLINE_E2E === "1";
const SHOTS = process.env.OLP_OFFLINE_SHOTS;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "apps/server-selfhost/src/main.ts");
const NAME = "olp.home.arpa";

const log = new ProcLog("selfhost-offline");
let proc: ChildProcess | undefined;
let front: Server | undefined;
let browser: Browser;
let dir = "";
let origin = "";
let server: ServerTarget;
let setupToken = "";
/** Every request a browser tried to make to anything but our server. */
const external: { url: string; from: string }[] = [];
/** Preloaded into the server: logs `OFFLINE-GUARD <what>` for anything leaving this machine. */
const GUARD = `
import dns from "node:dns";
import net from "node:net";
import dgram from "node:dgram";
const local = (h) => !h || h === "localhost" || /^(127\\.|::1$|::ffff:127\\.)/.test(String(h));
const say = (what) => process.stderr.write("OFFLINE-GUARD " + what + "\\n");
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) { if (!local(host)) say("dns " + host); return lookup.call(this, host, ...rest); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  if (!o.path && !local(o.host)) say("tcp " + o.host + ":" + o.port);
  return connect.apply(this, args);
};
const send = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const host = args.find((a, i) => i > 0 && typeof a === "string");
  if (!local(host)) say("udp " + host);
  return send.apply(this, args);
};
`;
/** Pages to screenshot when the test fails. */
const pages: Page[] = [];

/** A local CA and a certificate for NAME signed by it; returns the files and the CA's SPKI hash. */
function makeCert(): { key: string; cert: string; spki: string } {
  const f = (n: string) => join(dir, n);
  const run = (args: string[]) => {
    const r = spawnSync("openssl", args, { encoding: "utf8", cwd: dir });
    if (r.status !== 0) throw new Error(`openssl ${args[0]}: ${r.stderr}`);
  };
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  // The home CA (what you install on phones and computers).
  run(
    ["req", "-x509", ...ec, "-days", "3650", "-subj", "/CN=Home phone CA"].concat([
      "-keyout",
      f("ca.key"),
      "-out",
      f("ca.pem"),
    ]),
  );
  // The server's certificate, for its name on the home network.
  run(["req", ...ec, "-subj", `/CN=${NAME}`, "-keyout", f("key.pem"), "-out", f("req.csr")]);
  writeFileSync(
    f("ext.cnf"),
    `subjectAltName=DNS:${NAME}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`,
  );
  run(
    ["x509", "-req", "-in", f("req.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key")].concat([
      "-CAcreateserial",
      "-days",
      "397",
      "-extfile",
      f("ext.cnf"),
      "-out",
      f("cert.pem"),
    ]),
  );
  // The front sends the chain: its certificate, then the CA's.
  writeFileSync(
    f("chain.pem"),
    readFileSync(f("cert.pem"), "utf8") + readFileSync(f("ca.pem"), "utf8"),
  );
  const der = new X509Certificate(readFileSync(f("ca.pem"))).publicKey.export({
    type: "spki",
    format: "der",
  });
  return {
    key: f("key.pem"),
    cert: f("chain.pem"),
    spki: createHash("sha256").update(der).digest("base64"),
  };
}

/** The local HTTPS front: TLS here, plain HTTP and WebSockets to the server behind it. */
function startFront(files: { key: string; cert: string }, port: number, to: number) {
  const s = createHttps({ key: readFileSync(files.key), cert: readFileSync(files.cert) });
  s.on("request", (req, res) => {
    const up = httpRequest(
      { host: "127.0.0.1", port: to, method: req.method, path: req.url, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  s.on("upgrade", (req, sock, head) => {
    const up = connect(to, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      sock.pipe(up).pipe(sock);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  return new Promise<Server>((r) => s.listen(port, "127.0.0.1", () => r(s)));
}

/** Refuses and records every request a context makes to any host but ours. */
async function offline(context: BrowserContext, from: string): Promise<void> {
  type Route = {
    request(): { url(): string };
    continue(): Promise<void>;
    abort(code: string): Promise<void>;
  };
  await context.route("**/*", (route: Route) => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.continue();
    external.push({ url, from });
    return route.abort("internetdisconnected");
  });
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A companion whose API calls from this test go straight to the server (Node can't resolve NAME). */
class LanCompanion extends Companion {
  override get server(): ServerTarget {
    return server;
  }
}

/** Opens a companion for `handle` with our origin, offline. */
async function companion(handle: string): Promise<Companion> {
  const c = new LanCompanion(origin, handle);
  await c.open(browser);
  pages.push(c.page);
  await offline(c.context, handle);
  return c;
}

/** Finishes the "Stay signed in safely" (passkey) and recovery-code steps. */
async function onboard(c: Companion): Promise<void> {
  await c.page.getByRole("button", { name: "Add a passkey" }).click({ timeout: 20_000 });
  const code = c.page.getByLabel("Recovery code");
  await code.waitFor({ timeout: 20_000 });
  const text = (await code.innerText()).trim();
  await c.page.getByLabel(/type its last four characters/).fill(text.slice(-4));
  await c.page.locator(".card .primary").click();
  await c.page.locator("nav.tabs").waitFor({ timeout: 20_000 });
  // Skip the one-time welcome tour.
  await c.resume((await c.token()) as string);
  await c.refreshPerson();
}

/** RTP packets sent and received so far on a page's newest peer connection. */
async function packets(page: Page): Promise<{ sent: number; received: number }> {
  return page.evaluate(async () => {
    type H = { __olp?: { pcs: { pc: RTCPeerConnection }[] } };
    const pc = (window as unknown as H).__olp?.pcs.at(-1)?.pc;
    let sent = 0;
    let received = 0;
    if (pc)
      (await pc.getStats()).forEach(
        (r: { type: string; kind?: string; packetsSent?: number; packetsReceived?: number }) => {
          if (r.type === "outbound-rtp" && r.kind === "audio") sent += r.packetsSent ?? 0;
          if (r.type === "inbound-rtp" && r.kind === "audio") received += r.packetsReceived ?? 0;
        },
      );
    return { sent, received };
  });
}

async function audioFlows(page: Page): Promise<{ sent: number; received: number }> {
  const a = await packets(page);
  return until(
    "audio packets both ways",
    async () => {
      const b = await packets(page);
      return b.sent > a.sent + 20 && b.received > a.received + 20 ? b : undefined;
    },
    15_000,
  );
}

beforeAll(async () => {
  if (!ON) return;
  if (process.env.OLP_ADDON_NO_BUILD !== "1") {
    for (const w of ["@openloungephone/companion", "@openloungephone/device-web"]) {
      const b = spawnSync("npm", ["run", "build", "-w", w], { cwd: ROOT, encoding: "utf8" });
      if (b.status !== 0) throw new Error(`${w} build failed:\n${b.stderr}`);
    }
  }
  dir = mkdtempSync(join(tmpdir(), "olp-offline-"));
  const cert = makeCert();
  const port = await freePort();
  const tls = await freePort();
  origin = `https://${NAME}:${tls}`;
  // Records every connection or name lookup the server tries for anything but this machine.
  const guard = join(dir, "guard.mjs");
  writeFileSync(guard, GUARD);
  proc = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--import", guard, MAIN],
    {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        PUBLIC_URL: origin,
        DATA_DIR: join(dir, "data"),
        STUN_URLS: "",
        TURN_URLS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout?.on("data", log.add);
  proc.stderr?.on("data", log.add);
  setupToken = await until("the setup link", () => /#setup=(\S+)/.exec(log.text)?.[1], 20_000);
  front = await startFront(cert, tls, port);
  server = { base: `http://127.0.0.1:${port}`, origin };
  const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
  const chromium = pw.chromium ?? pw.default?.chromium;
  browser = (await chromium.launch({
    headless: true,
    args: [
      ...CHROMIUM_ARGS,
      // Only our name resolves (to this machine); everything else is "not found".
      `--host-resolver-rules=MAP ${NAME} 127.0.0.1, MAP * ~NOTFOUND`,
      // Trust our self-signed certificate, as a phone or computer would after installing it.
      `--ignore-certificate-errors-spki-list=${cert.spki}`,
    ],
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  })) as Browser;
}, 240_000);

afterAll(async () => {
  if (!ON) return;
  await browser?.close();
  front?.close();
  proc?.kill("SIGTERM");
  if (dir) rmSync(dir, { recursive: true, force: true });
  console.log(
    `offline: ${external.length} external request(s) refused:\n${external
      .map((e) => `  [${e.from}] ${e.url}`)
      .join("\n")}`,
  );
});

it.skipIf(!ON)(
  "setup, passkeys, pairing, calls both ways and voicemail with no internet",
  async () => {
    onTestFailed(async () => {
      reportLogs([log], "offline");
      for (const [i, pg] of pages.entries()) await shot(pg, `fail-${i}`).catch(() => {});
    });

    // First run from the printed link, over HTTPS on the home-network name.
    const ann = await companion("ann");
    await ann.page.goto(`${origin}/#setup=${setupToken}`);
    expect(await ann.page.evaluate(() => window.isSecureContext)).toBe(true);
    // Plain http on the network name isn't a secure context: no microphone, no passkeys.
    const plain = await browser.newPage();
    await plain.goto(`${server.base.replace("127.0.0.1", NAME)}/#setup=${setupToken}`);
    expect(
      await plain.evaluate(() => [
        window.isSecureContext,
        !!navigator.mediaDevices,
        typeof PublicKeyCredential,
      ]),
    ).toEqual([false, false, "undefined"]);
    await shot(plain, "00-plain-http");
    await plain.close();

    // The guard works: anything elsewhere fails and is recorded.
    const probe = await ann.page.evaluate(() =>
      fetch("https://example.com/probe").then(
        () => "reached",
        () => "refused",
      ),
    );
    expect(probe).toBe("refused");
    expect(external.splice(0).map((e) => e.url)).toEqual(["https://example.com/probe"]);
    await ann.page.getByLabel("Household name").fill("The Offline home");
    await ann.page.getByRole("textbox", { name: /^Your name/ }).fill("Ann");
    await ann.page.getByRole("button", { name: "Create household" }).click();
    await onboard(ann);
    expect((await ann.credentials()).length).toBe(1);
    await shot(ann.page, "01-ann-home");

    // The passkey signs her back in.
    await ann.signOut();
    await ann.signIn();
    await ann.refreshPerson();
    await ann.ready();

    // Ben joins by invite and makes his own passkey.
    const inv = await api(ann.person, "/invites", { body: { name: "Ben", role: "guardian" } });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    const ben = await companion("ben");
    await ben.page.goto(`${origin}/#invite=${inv.json.token}`);
    await ben.page.getByRole("button", { name: "Join as someone new" }).click();
    await onboard(ben);
    await ben.ready();

    // Ann's own phone: a browser phone at /device/, paired through her app.
    const phone = new Phone(origin, "offline-desk");
    await phone.open(browser, "personal");
    await offline(phone.context, "phone");
    pages.push(phone.page);
    const { pairing } = await phone.facts();
    await ann.tab("Home");
    await ann.page.getByRole("button", { name: /Pair (a|my) phone/ }).click();
    await ann.page.getByLabel("Pairing code").fill(pairing);
    await ann.page.getByRole("textbox", { name: /^Phone name/ }).fill("Desk");
    await ann.page.getByLabel(/My own phone/).check();
    await ann.page.getByRole("button", { name: "Pair phone" }).click();
    await phone.authed();
    await phone.waitKind("idle");
    await shot(phone.page, "02-phone-idle");

    // Ben calls Ann: her phone rings, she lifts the handset.
    await ben.tab("Home");
    const benBefore = await ben.pcCount();
    const phoneBefore = await phone.pcCount();
    await ben.page.getByRole("button", { name: "Call", exact: true }).last().click();
    await phone.waitKind("incoming");
    await phone.hook();
    const pcBen = await pcConnected(ben.page, benBefore);
    const pcPhone = await pcConnected(phone.page, phoneBefore);
    expect(pcBen.iceServers).toEqual([]);
    expect(await selectedCandidateType(ben.page)).toBe("host");
    expect(await selectedCandidateType(phone.page)).toBe("host");
    const flowBen = await audioFlows(ben.page);
    const flowPhone = await audioFlows(phone.page);
    console.log(
      `offline call ben→phone: ${pcBen.states.join(">")} / ${pcPhone.states.join(">")}; ` +
        `ben rtp ${JSON.stringify(flowBen)}, phone rtp ${JSON.stringify(flowPhone)}`,
    );
    await shot(phone.page, "03-phone-incall");
    await phone.hook();
    await ben.ended();
    await phone.waitKind("idle");

    // The phone calls Ben back from its first key that names him.
    const before2 = await phone.pcCount();
    await phone.hook();
    await phone.waitKind("offhook");
    const benKey = await benKeyOn(phone);
    await phone.press(benKey);
    await ben.answer();
    await pcConnected(phone.page, before2);
    expect(await selectedCandidateType(phone.page)).toBe("host");
    await audioFlows(phone.page);
    await ben.hangUp();
    await phone.waitKind("offhook").catch(() => phone.waitKind("idle"));
    if ((await phone.kind()) !== "idle") await phone.hook();

    // No answer: Ben leaves Ann a voicemail, which she can play.
    // (The greeting is spoken by the browser's own speech synthesis.)
    const ring = await api(ann.person, "/voicemail/settings", {
      method: "PATCH",
      body: { ringSeconds: 10 },
    });
    expect(ring.status, JSON.stringify(ring.json)).toBeLessThan(300);
    await ben.page.getByRole("button", { name: "Call", exact: true }).last().click();
    await phone.waitKind("incoming");
    const send = ben.page.getByRole("button", { name: "Hang up & send" });
    await send.waitFor({ timeout: 60_000 });
    await ben.page.waitForTimeout(3_000);
    await send.click();
    await ben.page.getByText(/Message sent to/).waitFor({ timeout: 20_000 });
    const box = await until(
      "the voicemail in Ann's inbox",
      async () => {
        const r = await api(ann.person, "/voicemails");
        const list = (r.json?.voicemails ?? r.json) as { id: string; durationMs: number }[];
        return list?.length ? list : undefined;
      },
      30_000,
    );
    const audio = await fetch(`${server.base}/api/voicemails/${box[0]?.id}/audio`, {
      headers: { authorization: `Bearer ${ann.person.token}` },
    });
    expect(audio.status).toBe(200);
    const bytes = (await audio.arrayBuffer()).byteLength;
    expect(bytes).toBeGreaterThan(1000);
    console.log(`offline voicemail: ${box[0]?.durationMs} ms, ${bytes} bytes`);

    // Neither the apps nor the server tried to reach anything else.
    expect(external).toEqual([]);
    expect(log.text.split("\n").filter((l) => l.startsWith("OFFLINE-GUARD"))).toEqual([]);
  },
  300_000,
);

/** The key (1-9, 0) on the phone that names Ben, from the phone's last config. */
function benKeyOn(phone: Phone): Promise<string> {
  return until(
    "Ben on a key",
    () => {
      const buttons = phone.lastFrame("config")?.buttons as
        | { index: number; label: string }[]
        | undefined;
      const i = buttons?.find((b) => /ben/i.test(b.label))?.index;
      return i === undefined ? undefined : String(i === 9 ? 0 : i + 1);
    },
    10_000,
  );
}
