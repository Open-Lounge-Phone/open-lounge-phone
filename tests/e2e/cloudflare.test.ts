// The two-server scenario against two local Cloudflare Workers (`wrangler dev`: local D1, R2 and
// Durable Objects; no AI), federating as a.localhost and b.localhost. Slow (about 2 minutes,
// including the stream's 60 s idle close), so it only runs when asked:
//   OLP_E2E_CLOUDFLARE=1 npx vitest run tests/e2e/cloudflare.test.ts
// Needs `npm run build` first (the static assets).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateServerKey } from "@openloungephone/federation";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  block,
  callAcross,
  knockAndAccept,
  noAnswerAcross,
  type ServerTarget,
  signUp,
  voicemailAcross,
} from "./twoServers.ts";

const APP = fileURLToPath(new URL("../../apps/server-cloudflare/", import.meta.url));
const enabled = process.env.OLP_E2E_CLOUDFLARE === "1";

interface Instance extends ServerTarget {
  proc: ChildProcess;
  dir: string;
  log: string;
}
const running: Instance[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function launch(name: string): Promise<Instance> {
  const [port, inspector] = [await freePort(), await freePort()];
  const dir = mkdtempSync(join(tmpdir(), `olp-cf-${name}-`));
  const origin = `http://${name}.localhost:${port}`;
  const envFile = join(dir, "dev.env");
  writeFileSync(
    envFile,
    [
      `PUBLIC_URL=${origin}`,
      "OPEN_SIGNUP=1",
      "DEV_LOOPBACK=1",
      "STUN_URLS=",
      `FED_PRIVATE_KEY='${await generateServerKey()}'`,
    ].join("\n"),
  );
  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", dir],
    { cwd: APP, input: "y\n", encoding: "utf8" },
  );
  if (migrate.status !== 0) throw new Error(`migrations failed:\n${migrate.stderr}`);
  const proc = spawn(
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
      "--name",
      `openloungephone-e2e-${name}`,
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
    ],
    { cwd: APP, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  const inst: Instance = { base: `http://127.0.0.1:${port}`, origin, proc, dir, log: "" };
  running.push(inst);
  const onData = (d: Buffer) => {
    inst.log += d.toString();
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  await vi.waitFor(
    () => {
      if (proc.exitCode !== null) throw new Error(`${name} exited:\n${inst.log}`);
      if (!inst.log.includes("Ready on")) throw new Error(`${name} not ready:\n${inst.log}`);
    },
    { timeout: 60_000, interval: 250 },
  );
  return inst;
}

let a: Instance;
let b: Instance;

beforeAll(async () => {
  if (!enabled) return;
  [a, b] = await Promise.all([launch("a"), launch("b")]);
}, 120_000);

afterAll(() => {
  for (const inst of running) {
    try {
      // wrangler spawns workerd: end the whole process group.
      if (inst.proc.pid) process.kill(-inst.proc.pid, "SIGTERM");
    } catch {}
    rmSync(inst.dir, { recursive: true, force: true });
  }
});

it.skipIf(!enabled)(
  "two Cloudflare Workers: knock, accept, call, no-answer voicemail, voicemail, block, and the idle stream closes",
  async () => {
    const jesse = await signUp(a, "jesse", "Jesse");
    const bob = await signUp(b, "bob", "Bob");
    await knockAndAccept(jesse, bob);
    await callAcross(jesse, bob);
    await noAnswerAcross(jesse, bob);
    await voicemailAcross(jesse, bob);
    // The server that dialed the stream closes it about a minute after the last signal.
    const dialed = () =>
      [a, b].filter((i) => i.log.includes("stream: closed after idle")).map((i) => i.origin);
    await vi.waitFor(() => expect(dialed().length).toBeGreaterThan(0), {
      timeout: 90_000,
      interval: 1000,
    });
    // ...and a new call opens it again.
    await callAcross(jesse, bob);
    await block(jesse, bob);
  },
  240_000,
);
