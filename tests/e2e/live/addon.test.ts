// The add-on bridge end to end, entirely on this machine: a self-hosted server with add-ons on,
// the Python echo add-on (sdk/python/examples/echo.py) linked through the companion app in
// headless Chromium (fake microphone), a call from the app to the add-on with real WebRTC audio
// both ways, and a call from the add-on to its owner. Then sharing: the add-on offers a share,
// its owner gives it to a connection in the app, she calls the share's address from her
// Connections tab (the add-on is told the share), someone else sees nothing of it, and "New
// shared project with…" makes a second share that the add-on creates.
//
//   OLP_ADDON_E2E=1 PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core [CHROME=/path/to/chrome] \
//     npx vitest run tests/e2e/live/addon.test.ts
//
// Needs the bridge's venv (`python3 -m venv sdk/python/.venv && sdk/python/.venv/bin/pip install
// -e sdk/python`; or OLP_ADDON_PYTHON). Builds the companion first (OLP_ADDON_NO_BUILD=1 reuses
// apps/companion/dist).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { freePort, ProcLog, reportLogs } from "../procs.ts";
import { api, type Person, type ServerTarget, signUp } from "../twoServers.ts";
import { CHROMIUM_ARGS, Companion, pcConnected, until } from "./browser.ts";

const ON = process.env.OLP_ADDON_E2E === "1";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "apps/server-selfhost/src/main.ts");
const PYTHON = process.env.OLP_ADDON_PYTHON ?? join(ROOT, "sdk/python/.venv/bin/python");
const ECHO = join(ROOT, "sdk/python/examples/echo.py");

let server: ServerTarget;
let serverProc: ChildProcess | undefined;
let dataDir = "";
let browser: Browser | undefined;
const logs: ProcLog[] = [];
const addons: ChildProcess[] = [];

async function startServer(): Promise<void> {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "olp-addon-"));
  // localhost: a secure context for the microphone, and the origin passkeys are made for.
  const origin = `http://localhost:${port}`;
  const log = new ProcLog("selfhost-addon");
  logs.push(log);
  serverProc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: origin,
      DATA_DIR: dataDir,
      OPEN_SIGNUP: "1",
      ADDONS: "on",
      STUN_URLS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout?.on("data", log.add);
  serverProc.stderr?.on("data", log.add);
  await until("the server listening", () => log.text.includes("listening on"), 20_000);
  server = { base: origin, origin };
}

/** The echo add-on as a process; resolves with its log, which the test reads. */
function startEcho(name: string, keyFile: string, extra: string[] = []): ProcLog {
  const log = new ProcLog(name);
  logs.push(log);
  const proc = spawn(PYTHON, [ECHO, "--server", server.base, "--key", keyFile, ...extra], {
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", log.add);
  proc.stderr?.on("data", log.add);
  addons.push(proc);
  return log;
}

/** Screenshots for a look at the screens (OLP_ADDON_SHOTS=<dir>). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.OLP_ADDON_SHOTS;
  if (dir) await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** RTP the page's newest peer connection received (audio from the other side). */
async function inboundBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    type Rec = { pc: RTCPeerConnection };
    const pc = (window as unknown as { __olp?: { pcs: Rec[] } }).__olp?.pcs.at(-1)?.pc;
    if (!pc) return 0;
    let bytes = 0;
    (await pc.getStats()).forEach((r: { type: string; kind?: string; bytesReceived?: number }) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") bytes = r.bytesReceived ?? 0;
    });
    return bytes;
  });
}

beforeAll(async () => {
  if (!ON) return;
  if (process.env.OLP_ADDON_NO_BUILD !== "1") {
    const build = spawnSync("npm", ["run", "build", "-w", "@openloungephone/companion"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (build.status !== 0) throw new Error(`companion build failed:\n${build.stderr}`);
  }
  await startServer();
  const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
  const chromium = pw.chromium ?? pw.default?.chromium;
  browser = (await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
    ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  })) as Browser;
}, 180_000);

afterAll(async () => {
  for (const p of addons) p.kill("SIGTERM");
  await browser?.close();
  serverProc?.kill("SIGTERM");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

it.skipIf(!ON)(
  "the Python echo add-on: linked in the app, called with real audio, calling its owner",
  async () => {
    onTestFailed(() => reportLogs(logs, "the add-on scenario failed"));
    const jesse = await signUp(server, "jesse", "Jesse");
    const app = new Companion(server.origin, "jesse");
    await app.open(browser);
    await app.resume(jesse.token);
    const page = app.page;

    // The add-on asks for a code; Jesse enters it under Settings → Add-ons.
    const keyDir = mkdtempSync(join(tmpdir(), "olp-addon-key-"));
    const keyFile = join(keyDir, "echo.addon-key");
    const echo = startEcho("echo-1", keyFile);
    const code = await until(
      "the add-on's link code",
      () => /Link code: (\d{6})/.exec(echo.text)?.[1],
      30_000,
    );
    await app.tab("Settings");
    const card = page.locator(".addons");
    await card.getByRole("button", { name: "Link an add-on" }).click();
    await card.getByLabel("Code").fill(code);
    await card.getByLabel("Name").fill("echo");
    await card.getByRole("button", { name: "Link", exact: true }).click();
    const address = `jesse+echo@${new URL(server.origin).host}`;
    await page.getByText(`Linked. echo is at ${address}.`).waitFor({ timeout: 10_000 });
    await until("the add-on connected", () => echo.text.includes(`ready ${address}`), 20_000);
    const row = page.locator("li.addon", { hasText: address });
    // Online, as the server reports it (the list is read again every 15 s).
    await until(
      "the add-on listed as online",
      async () => (await row.innerText()).includes("Online"),
      25_000,
      500,
    );

    await shot(page, "1-settings-addons");

    // Jesse calls it from the app: it hears her, and she hears herself echoed back.
    const pcsBefore = await app.pcCount();
    await row.getByRole("button", { name: "Call" }).click();
    await until("the add-on answering", () => echo.text.includes("call from Jesse"), 20_000);
    expect(echo.text).toContain(`call from Jesse <jesse@${new URL(server.origin).host}>`);
    await pcConnected(page, pcsBefore, 30_000);
    await expect
      .poll(() => app.overlay().innerText(), { timeout: 10_000 })
      .toMatch(/echo\s*add-on/);
    await until("audio frames at the add-on", () => echo.text.includes("heard 100 frames"), 30_000);
    const first = await inboundBytes(page);
    await new Promise((r) => setTimeout(r, 2000));
    const later = await inboundBytes(page);
    expect(later - first).toBeGreaterThan(4000); // ~2 s of echoed audio came back
    console.log(`app → add-on: echoed audio back ${later - first} bytes in 2 s`);
    // A key from the keypad reaches it.
    await app.overlay().getByRole("button", { name: "Keypad" }).click();
    await app.overlay().getByRole("button", { name: "5", exact: true }).click();
    await until("the key at the add-on", () => echo.text.includes("key 5"), 10_000);
    await shot(page, "2-call-with-addon");
    await app.hangUp();
    await app.ended();
    await until("the add-on's call ended", () => echo.text.includes("call ended"), 10_000);

    // The add-on calls its owner (the same key file: it's linked already).
    addons.at(-1)?.kill("SIGTERM");
    const caller = startEcho("echo-2", keyFile, ["--call", jesse.address]);
    await page.locator(".overlay-incoming").waitFor({ timeout: 30_000 });
    expect(await app.overlay().innerText()).toMatch(/echo\s*add-on/);
    expect(await app.overlay().innerText()).toContain(address);
    await shot(page, "3-addon-calling");
    const pcsNow = await app.pcCount();
    await app.answer();
    await pcConnected(page, pcsNow, 30_000);
    await until(
      "audio frames at the calling add-on",
      () => caller.text.includes("heard 50 frames"),
      30_000,
    );
    const a = await inboundBytes(page);
    await new Promise((r) => setTimeout(r, 2000));
    const b = await inboundBytes(page);
    expect(b - a).toBeGreaterThan(4000);
    console.log(`add-on → owner: echoed audio back ${b - a} bytes in 2 s`);
    console.log(
      echo.text
        .split("\n")
        .concat(caller.text.split("\n"))
        .filter((l) => /^(ready|call|heard 100|key)/.test(l))
        .join("\n"),
    );
    await app.hangUp();
    await app.ended();
    rmSync(keyDir, { recursive: true, force: true });
  },
  240_000,
);

/** `a` knocks on `b` (same server) and `b` accepts. */
async function befriend(a: Person, b: Person): Promise<void> {
  expect((await api(a, "/connections", { body: { to: b.address } })).status).toBe(202);
  const knock = (await api(b, "/connections")).json.connections.find(
    (c: { address: string }) => c.address === a.address,
  );
  expect((await api(b, `/connections/${knock.id}/accept`, { method: "POST" })).status).toBe(200);
}

it.skipIf(!ON)(
  "sharing: the echo add-on offers a share, its owner gives it, the holder calls it",
  async () => {
    onTestFailed(() => reportLogs(logs, "the add-on sharing scenario failed"));
    const host = new URL(server.origin).host;
    const jo = await signUp(server, "jo", "Jo");
    const ana = await signUp(server, "ana", "Ana");
    const cy = await signUp(server, "cy", "Cy");
    await befriend(jo, ana);
    await befriend(jo, cy);

    // The add-on, linked to Jo (through the API; the first test links one in the app), offering
    // one share.
    const keyDir = mkdtempSync(join(tmpdir(), "olp-addon-key-"));
    const keyFile = join(keyDir, "seat.addon-key");
    const seat = startEcho("echo-shares", keyFile, ["--share", "bookclub:Book club"]);
    const code = await until(
      "its link code",
      () => /Link code: (\d{6})/.exec(seat.text)?.[1],
      30_000,
    );
    const linked = await api(jo, "/addons/link", { body: { code, name: "seat" } });
    expect(linked.status).toBe(201);
    await until("connected", () => seat.text.includes(`ready jo+seat@${host}`), 20_000);
    await until(
      "its share at the server",
      async () => (await api(jo, "/addons")).json.addons[0]?.shares.length === 1,
      10_000,
      200,
    );

    // Jo gives it to Ana on the add-on's card.
    const joApp = new Companion(server.origin, "jo");
    await joApp.open(browser);
    await joApp.resume(jo.token);
    joApp.page.on("dialog", (d: { accept(): Promise<void> }) => void d.accept());
    await joApp.tab("Settings");
    const card = joApp.page.locator("li.addon", { hasText: `jo+seat@${host}` });
    await card.getByText(`jo+seat+bookclub@${host}`).waitFor({ timeout: 20_000 });
    await card.getByRole("button", { name: "Give to…" }).click();
    await card.locator("select").selectOption({ label: `Ana (ana@${host})` });
    await card.getByRole("button", { name: "Give", exact: true }).click();
    await joApp.page.getByText("Book club is shared with Ana.").waitFor({ timeout: 10_000 });
    await shot(joApp.page, "4-owner-gave-share");

    // Ana sees it in Connections and calls it; the add-on is told who and through which share.
    const anaApp = new Companion(server.origin, "ana");
    await anaApp.open(browser);
    await anaApp.resume(ana.token);
    await anaApp.tab("Connect");
    const entry = anaApp.page.locator("li", { hasText: "Jo's seat · Book club" }).last();
    await entry.waitFor({ timeout: 20_000 });
    await shot(anaApp.page, "5-holder-connections");
    const before = await anaApp.pcCount();
    await entry.getByRole("button", { name: "Call" }).click();
    await until(
      "the call through the share",
      () => seat.text.includes("through share bookclub"),
      20_000,
    );
    expect(seat.text).toContain(`call from Ana <ana@${host}>`);
    await pcConnected(anaApp.page, before, 30_000);
    await expect
      .poll(() => anaApp.overlay().innerText(), { timeout: 10_000 })
      .toMatch(/seat · Book club/);
    await anaApp.hangUp();
    await anaApp.ended();

    // Cy, connected with Jo but given nothing, sees nothing of it.
    const cyApp = new Companion(server.origin, "cy");
    await cyApp.open(browser);
    await cyApp.resume(cy.token);
    await cyApp.tab("Connect");
    await cyApp.page.getByText("Connected").first().waitFor({ timeout: 20_000 });
    const cyText = await cyApp.page.locator("section.connections").innerText();
    expect(cyText).not.toContain("Jo's seat");
    expect(cyText).not.toContain("Book club");
    expect((await api(cy, "/addons/shared")).json.held).toEqual([]);
    await shot(cyApp.page, "6-neither-connections");

    // Jo sees her add-on and who has its share.
    await joApp.tab("Connect");
    await joApp.page.getByText("Book club: shared with Ana").waitFor({ timeout: 20_000 });
    await shot(joApp.page, "7-owner-connections");

    // New shared project with…: the add-on makes it, and Ana gets it.
    await joApp.tab("Settings");
    await card.getByRole("button", { name: "New shared project with…" }).click();
    const form = card.locator("form", { hasText: "New shared project with…" });
    await form.getByLabel("Name").fill("Garden");
    await form.getByLabel(/Ana/).check();
    await form.getByRole("button", { name: "Ask" }).click();
    await form.getByText("Done. Garden is shared with Ana.").waitFor({ timeout: 20_000 });
    expect(seat.text).toContain("share request 'Garden'");
    await shot(joApp.page, "8-new-shared-project");
    await form.getByRole("button", { name: "Done" }).click();
    await card.getByText(`jo+seat+garden@${host}`).waitFor({ timeout: 20_000 });

    // Revoked: Ana keeps only Garden.
    await card
      .locator("li", { hasText: `jo+seat+bookclub@${host}` })
      .getByRole("button", { name: "Revoke" })
      .click();
    await joApp.page.getByText("Ana no longer has Book club.").waitFor({ timeout: 10_000 });
    expect(
      (await api(ana, "/addons/shared")).json.held.map(
        (h: { share: { id: string } }) => h.share.id,
      ),
    ).toEqual(["garden"]);
    rmSync(keyDir, { recursive: true, force: true });
  },
  240_000,
);
