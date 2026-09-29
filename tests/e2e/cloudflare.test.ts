// The two-server scenario against two local Cloudflare Workers (`wrangler dev`: local D1, R2 and
// Durable Objects; no AI), federating as a.localhost and b.localhost. Slow (about 2 minutes,
// including the stream's 60 s idle close), so it only runs when asked:
//   OLP_E2E_CLOUDFLARE=1 npx vitest run tests/e2e/cloudflare.test.ts
// Needs `npm run build` first (the static assets).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateServerKey } from "@openloungephone/federation";
import { afterAll, beforeAll, expect, it, onTestFailed, vi } from "vitest";
import { freePort, ProcLog, reportLogs, retryOnce, saveLogs } from "./procs.ts";
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
  name: string;
  proc: ChildProcess;
  dir: string;
  log: ProcLog;
}
const running: Instance[] = [];

function stop(inst: Instance) {
  try {
    // wrangler spawns workerd: end the whole process group.
    if (inst.proc.pid && inst.proc.exitCode === null) process.kill(-inst.proc.pid, "SIGTERM");
  } catch {}
  rmSync(inst.dir, { recursive: true, force: true });
}

async function start(name: string, attempt: number): Promise<Instance> {
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
  const log = new ProcLog(`wrangler-${name}${attempt > 1 ? `-try${attempt}` : ""}`);
  log.add(migrate.stdout ?? "");
  const inst: Instance = { name, base: `http://127.0.0.1:${port}`, origin, proc, dir, log };
  running.push(inst);
  proc.stdout?.on("data", log.add);
  proc.stderr?.on("data", log.add);
  await vi.waitFor(
    () => {
      if (proc.exitCode !== null) throw new Error(`${name} exited:\n${log.text}`);
      if (!log.text.includes("Ready on")) throw new Error(`${name} not ready:\n${log.text}`);
    },
    { timeout: 60_000, interval: 250 },
  );
  return inst;
}

/** Starting `wrangler dev` is the timing-sensitive step: one retry, on fresh ports and state. */
const launch = (name: string) =>
  retryOnce(
    `starting wrangler dev for ${name}`,
    (attempt) => start(name, attempt),
    () => {
      for (const inst of running) if (inst.name === name) stop(inst);
    },
  );

let a: Instance;
let b: Instance;

beforeAll(async () => {
  if (!enabled) return;
  [a, b] = await Promise.all([launch("a"), launch("b")]);
}, 240_000);

afterAll(() => {
  saveLogs(running.map((i) => i.log));
  for (const inst of running) stop(inst);
});

it.skipIf(!enabled)(
  "two Cloudflare Workers: knock, accept, call, no-answer voicemail, voicemail, block, and the idle stream closes",
  async () => {
    onTestFailed(() =>
      reportLogs(
        running.map((i) => i.log),
        "the Cloudflare scenario failed",
      ),
    );
    const jesse = await signUp(a, "jesse", "Jesse");
    const bob = await signUp(b, "bob", "Bob");
    await knockAndAccept(jesse, bob);
    await callAcross(jesse, bob);
    await noAnswerAcross(jesse, bob);
    await voicemailAcross(jesse, bob);
    // The server that dialed the stream closes it about a minute after the last signal.
    // Timers in workerd are only as punctual as the machine: allow one more minute if needed.
    const dialed = () =>
      [a, b].filter((i) => i.log.text.includes("stream: closed after idle")).map((i) => i.origin);
    await retryOnce("waiting for the idle stream to close", () =>
      vi.waitFor(() => expect(dialed().length).toBeGreaterThan(0), {
        timeout: 90_000,
        interval: 1000,
      }),
    );
    // ...and a new call opens it again.
    await callAcross(jesse, bob);
    await block(jesse, bob);
  },
  360_000,
);
