// Two self-host server processes on different host names (a.localhost, b.localhost; *.localhost
// is loopback) federate with each other: the interop scenario from docs/federation.md.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, it, onTestFailed } from "vitest";
import { freePort, ProcLog, reportLogs, retryOnce, saveLogs } from "./procs.ts";
import {
  block,
  callAcross,
  connectLocally,
  knockAndAccept,
  mergeAcross,
  noAnswerAcross,
  removeAndWipe,
  roomsAcross,
  rotateMidCall,
  type ServerTarget,
  signUp,
  timelineAcross,
  voicemailAcross,
  workplaceAcross,
} from "./twoServers.ts";

const MAIN = fileURLToPath(new URL("../../apps/server-selfhost/src/main.ts", import.meta.url));
const running: { proc: ChildProcess; dir: string; log: ProcLog }[] = [];

function stop(entry: { proc: ChildProcess; dir: string }) {
  entry.proc.kill("SIGTERM");
  rmSync(entry.dir, { recursive: true, force: true });
}

async function start(name: string, attempt: number): Promise<ServerTarget> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), `olp-${name}-`));
  const origin = `http://${name}.localhost:${port}`;
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: origin,
      DATA_DIR: dir,
      OPEN_SIGNUP: "1",
      STUN_URLS: "",
      // Each server's own account runs it (the key rotation step).
      OPERATORS: "jesse,bob",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = new ProcLog(`selfhost-${name}${attempt > 1 ? `-try${attempt}` : ""}`);
  running.push({ proc, dir, log });
  proc.stdout?.on("data", log.add);
  proc.stderr?.on("data", log.add);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} didn't start:\n${log.text}`)), 15_000);
    const onData = () => {
      if (log.text.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`${name} exited ${code}:\n${log.text}`)));
  });
  return { base: `http://127.0.0.1:${port}`, origin };
}

/** Starting a server is the timing-sensitive step: one retry, on a fresh port and directory. */
const launch = (name: string) =>
  retryOnce(
    `starting ${name}`,
    (attempt) => start(name, attempt),
    () => {
      for (const r of running) if (r.log.name === `selfhost-${name}`) stop(r);
    },
  );

let a: ServerTarget;
let b: ServerTarget;

beforeAll(async () => {
  [a, b] = await Promise.all([launch("a"), launch("b")]);
}, 45_000);

afterAll(() => {
  saveLogs(running.map((r) => r.log));
  for (const entry of running) stop(entry);
});

it("two servers: sign up on each, knock, accept, call, voicemail, timeline, key rotation mid-call, wipe, rooms, 3-way, block, workplace transfer", async () => {
  onTestFailed(() =>
    reportLogs(
      running.map((r) => r.log),
      "the two-server scenario failed",
    ),
  );
  const jesse = await signUp(a, "jesse", "Jesse");
  const bob = await signUp(b, "bob", "Bob");
  await knockAndAccept(jesse, bob);
  await callAcross(jesse, bob);
  await noAnswerAcross(jesse, bob);
  await timelineAcross(jesse, bob);
  await rotateMidCall(jesse, bob);
  await removeAndWipe(bob);
  await voicemailAcross(jesse, bob);
  // Rooms without a relay (a peer-to-peer mesh), and a 3-way merge across households and servers.
  await roomsAcross(jesse, bob);
  const carol = await signUp(a, "carol", "Carol");
  await connectLocally(jesse, carol);
  await mergeAcross(jesse, bob, carol);
  await block(jesse, bob);
  // A team space on A takes Bob's call and transfers him to its ring group.
  await workplaceAcross(a, bob);
}, 90_000);
