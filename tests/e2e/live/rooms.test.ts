// Rooms through the real Cloudflare Realtime SFU, against a local `wrangler dev` (local D1, DOs;
// the SFU is Cloudflare's). The SFU app's credentials go in apps/server-cloudflare/.dev.vars
// (SFU_APP_ID=…, SFU_APP_SECRET=…; gitignored). Three headless Chromium companions with fake
// microphones join one room through the app's UI; audio must flow both ways for everyone; one
// leaves and rejoins; then a 1:1 call becomes a 3-way room with Add caller → Merge.
// Only runs when asked (it's slow, and uses real SFU minutes):
//   OLP_SFU_CHECK=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=/path/to/chrome] \
//     npx vitest run tests/e2e/live/rooms.test.ts
// Needs `npm run build` and `npm run assets -w apps/server-cloudflare` first.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { afterAll, expect, it } from "vitest";
import { api, connectLocally, type ServerTarget, signUp } from "../twoServers.ts";
import { CHROMIUM_ARGS, Companion, until } from "./browser.ts";

const APP = fileURLToPath(new URL("../../../apps/server-cloudflare/", import.meta.url));
const enabled = process.env.OLP_SFU_CHECK === "1";
let proc: ChildProcess | undefined;
let dir: string | undefined;
let browser: Browser | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** `wrangler dev` with the SFU credentials from .dev.vars (never printed). */
async function launch(): Promise<ServerTarget> {
  const vars = join(APP, ".dev.vars");
  if (!existsSync(vars) || !/SFU_APP_SECRET=\S/.test(readFileSync(vars, "utf8"))) {
    throw new Error("put SFU_APP_ID and SFU_APP_SECRET in apps/server-cloudflare/.dev.vars");
  }
  const [port, inspector] = [await freePort(), await freePort()];
  dir = mkdtempSync(join(tmpdir(), "olp-sfu-"));
  const origin = `http://localhost:${port}`;
  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", dir],
    { cwd: APP, input: "y\n", encoding: "utf8" },
  );
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stderr}`);
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--inspector-port",
      String(inspector),
      "--persist-to",
      dir,
      "--var",
      `PUBLIC_URL:${origin}`,
      "--var",
      "OPEN_SIGNUP:1",
    ],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"] },
  );
  proc = child;
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wrangler dev didn't start:\n${log}`)), 90_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (process.env.OLP_DEBUG) process.stderr.write(`[wrangler] ${d.toString()}`);
      if (log.includes("Ready on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => reject(new Error(`wrangler dev exited ${code}:\n${log}`)));
  });
  return { base: origin, origin };
}

afterAll(async () => {
  await browser?.close();
  if (proc?.pid) proc.kill("SIGTERM");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Audio bytes received per inbound track and sent, over every peer connection on the page. */
async function audioBytes(
  page: Page,
): Promise<{ inbound: number[]; sent: number; relays: number }> {
  return page.evaluate(async () => {
    type Rec = { pc: RTCPeerConnection };
    const pcs = (window as unknown as { __olp?: { pcs: Rec[] } }).__olp?.pcs ?? [];
    const inbound: number[] = [];
    let sent = 0;
    let relays = 0;
    for (const { pc } of pcs) {
      if (pc.connectionState !== "connected") continue;
      relays++;
      const stats = await pc.getStats();
      stats.forEach(
        (r: { type: string; kind?: string; bytesReceived?: number; bytesSent?: number }) => {
          if (r.type === "inbound-rtp" && r.kind === "audio") inbound.push(r.bytesReceived ?? 0);
          if (r.type === "outbound-rtp" && r.kind === "audio") sent += r.bytesSent ?? 0;
        },
      );
    }
    return { inbound, sent, relays };
  });
}

/** Waits until `page` sends audio and receives it from at least `n` sources, all growing. */
async function hearing(label: string, page: Page, n: number): Promise<number> {
  let before = await audioBytes(page);
  return until(
    `${label} hears ${n}`,
    async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const now = await audioBytes(page);
      const growing = now.inbound.filter((b, i) => b > (before.inbound[i] ?? 0)).length;
      const sending = now.sent > before.sent;
      before = now;
      if (process.env.OLP_DEBUG) process.stderr.write(`\n${label}: ${JSON.stringify(now)}`);
      return sending && growing >= n ? growing : undefined;
    },
    45_000,
    100,
  ).catch(async (e) => {
    const detail = await page.evaluate(() => {
      type Rec = { pc: RTCPeerConnection; states: string[] };
      const pcs = (window as unknown as { __olp?: { pcs: Rec[] } }).__olp?.pcs ?? [];
      return pcs.map((r) => ({
        state: r.pc.connectionState,
        states: r.states,
        transceivers: r.pc
          .getTransceivers()
          .map((t) => `${t.mid}:${t.direction}:${t.currentDirection}`),
        signaling: r.pc.signalingState,
      }));
    });
    throw new Error(
      `${String(e)}\n${JSON.stringify(detail)}\n${JSON.stringify(await audioBytes(page))}`,
    );
  });
}

async function inRoom(c: Companion, people: number): Promise<void> {
  await until(
    `${c.handle} sees ${people} in the room`,
    async () => (await c.page.locator(".overlay-room .room-people li").count()) === people,
    45_000,
  );
}

it.skipIf(!enabled)(
  "rooms through the real SFU: three people, audio both ways, leave and rejoin, then a 3-way merge",
  async () => {
    const server = await launch();
    const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    const chromium = pw.chromium ?? pw.default?.chromium;
    browser = (await chromium.launch({
      headless: process.env.OLP_LIVE_HEADED !== "1",
      args: CHROMIUM_ARGS,
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    })) as Browser;

    // Three people with their own spaces; Amy's phone room is open to her connections.
    const amy = await signUp(server, "amy", "Amy");
    const ben = await signUp(server, "ben", "Ben");
    const cat = await signUp(server, "cat", "Cat");
    await connectLocally(amy, ben);
    await connectLocally(amy, cat);
    const made = await api(amy, "/rooms", {
      body: { kind: "phone", name: "Standup", handle: "standup", access: "connections" },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const address = made.json.address as string;

    const [a, b, c] = [
      new Companion(server.origin, "amy"),
      new Companion(server.origin, "ben"),
      new Companion(server.origin, "cat"),
    ];
    for (const [actor, person] of [
      [a, amy],
      [b, ben],
      [c, cat],
    ] as const) {
      await actor.open(browser);
      await actor.resume(person.token);
      actor.person = person;
    }

    const skipRoom = process.env.OLP_SFU_SKIP_ROOM === "1";
    if (!skipRoom) {
      // Amy joins from her room list; Ben and Cat join by address.
      await a.tab("Rooms");
      await a.page
        .locator("li.device", { hasText: "Standup" })
        .getByRole("button", { name: "Join" })
        .click();
      for (const x of [b, c]) {
        await x.tab("Rooms");
        await x.page.getByLabel("Join a phone room by address").fill(address);
        await x.page
          .locator("form", { hasText: "Join a phone room by address" })
          .getByRole("button", { name: "Join" })
          .click();
      }
      for (const x of [a, b, c]) await inRoom(x, 3);
      // Honest labelling: relayed, not end to end.
      expect(await a.page.locator(".overlay-room").innerText()).toMatch(/not end to end/);
      for (const x of [a, b, c]) await hearing(x.handle, x.page, 2);

      // Cat drops out and comes back.
      await c.page.locator(".overlay-room").getByRole("button", { name: "Leave" }).click();
      await inRoom(a, 2);
      await inRoom(b, 2);
      await hearing("amy (after cat left)", a.page, 1);
      await c.page.getByLabel("Join a phone room by address").fill(address);
      await c.page
        .locator("form", { hasText: "Join a phone room by address" })
        .getByRole("button", { name: "Join" })
        .click();
      for (const x of [a, b, c]) await inRoom(x, 3);
      await hearing("cat (rejoined)", c.page, 2);
      await hearing("amy (cat back)", a.page, 2);
      for (const x of [a, b, c]) {
        await x.page.locator(".overlay-room").getByRole("button", { name: "Leave" }).click();
        await x.page.locator(".overlay-room").waitFor({ state: "detached", timeout: 20_000 });
      }
    }

    // A 1:1 call (peer to peer) becomes a 3-way room: Add caller, then Merge.
    await a.tab("Connect");
    await a.page
      .locator("li.card", { hasText: ben.address })
      .getByRole("button", { name: "Call", exact: true })
      .first()
      .click();
    await b.answer();
    await until(
      "amy's call active",
      async () => /\d+:\d\d/.test(await a.overlay().innerText()),
      30_000,
    ).catch(async (e) => {
      throw new Error(
        `${e}: amy shows "${await a.overlay().innerText()}", ben shows "${await b
          .overlay()
          .innerText()
          .catch(() => "")}"`,
      );
    });
    await a.overlay().getByRole("button", { name: "Add caller" }).click();
    await a.page.locator(".held-bar", { hasText: "Ben" }).waitFor({ timeout: 20_000 });
    await a.page.locator(".picker").getByRole("button", { name: /Cat/ }).click();
    await c.answer();
    await until(
      "amy's consult call active",
      async () => {
        const text = await a.page
          .locator(".overlay-active")
          .innerText()
          .catch(() => "");
        return /\d+:\d\d/.test(text);
      },
      30_000,
    );
    await a.page.locator(".held-bar").getByRole("button", { name: "Merge" }).click();
    for (const x of [a, b, c]) await inRoom(x, 3);
    expect(await b.page.locator(".overlay-room").innerText()).toMatch(/3-way call/);
    for (const x of [a, b, c]) await hearing(`${x.handle} (3-way)`, x.page, 2);
    for (const x of [b, c])
      await x.page.locator(".overlay-room").getByRole("button", { name: "Leave" }).click();
    await a.page.locator(".overlay-room").waitFor({ state: "detached", timeout: 20_000 });
  },
  420_000,
);
