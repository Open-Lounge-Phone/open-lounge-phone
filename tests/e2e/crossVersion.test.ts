// This server against the previous released server (git tag `server-v*`, pinned in
// .github/workflows/interop.yml), both self-hosted on different host names: the core two-server
// scenario (knock, accept, call, voicemail, block) in both directions, old → new and new → old.
//
// Needs a checkout of the release with its dependencies installed:
//   OLP_BASELINE_DIR=/path/to/checkout npx vitest run tests/e2e/crossVersion.test.ts
// Skipped without it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from "vitest";
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

const BASELINE = process.env.OLP_BASELINE_DIR;
const CURRENT_MAIN = fileURLToPath(
  new URL("../../apps/server-selfhost/src/main.ts", import.meta.url),
);
const mainOf = (root: string) => join(root, "apps/server-selfhost/src/main.ts");
const running: { proc: ChildProcess; dir: string; log: ProcLog }[] = [];

function stop(entry: { proc: ChildProcess; dir: string }) {
  entry.proc.kill("SIGTERM");
  rmSync(entry.dir, { recursive: true, force: true });
}

async function start(name: string, main: string, attempt: number): Promise<ServerTarget> {
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), `olp-xv-${name}-`));
  const origin = `http://${name}.localhost:${port}`;
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", main], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      PUBLIC_URL: origin,
      DATA_DIR: dir,
      OPEN_SIGNUP: "1",
      STUN_URLS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = new ProcLog(`crossversion-${name}${attempt > 1 ? `-try${attempt}` : ""}`);
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

const launch = (name: string, main: string) =>
  retryOnce(
    `starting ${name}`,
    (attempt) => start(name, main, attempt),
    () => {
      for (const r of running) if (r.log.name === `crossversion-${name}`) stop(r);
    },
  );

async function wellKnown(s: ServerTarget) {
  return (await (await fetch(`${s.base}/.well-known/openloungephone`)).json()) as {
    software?: string;
    versions?: Record<string, string>;
    features?: string[];
  };
}

describe.skipIf(!BASELINE)("this server and the previous release", () => {
  let old: ServerTarget;
  let current: ServerTarget;

  beforeAll(async () => {
    const baselineMain = mainOf(BASELINE as string);
    if (!existsSync(baselineMain)) throw new Error(`no server at ${baselineMain}`);
    [old, current] = await Promise.all([launch("old", baselineMain), launch("new", CURRENT_MAIN)]);
  }, 45_000);

  afterAll(() => {
    saveLogs(running.map((r) => r.log));
    for (const entry of running) stop(entry);
  });

  it("are two different versions", async () => {
    const [o, n] = [await wellKnown(old), await wellKnown(current)];
    console.log(`[crossversion] old: ${o.software}; new: ${n.software}`);
    expect(n.software).not.toBe(o.software);
    expect(n.versions).toEqual({ "1": "/fed/v1" });
  });

  it("old → new: knock, accept, call, voicemail (phone and person), block", async () => {
    onTestFailed(() =>
      reportLogs(
        running.map((r) => r.log),
        "old → new failed",
      ),
    );
    const jesse = await signUp(old, "jesse", "Jesse");
    const bob = await signUp(current, "bob", "Bob");
    await knockAndAccept(jesse, bob);
    await callAcross(jesse, bob);
    await voicemailAcross(jesse, bob);
    await noAnswerAcross(jesse, bob);
    await block(jesse, bob);
  }, 120_000);

  it("new → old: knock, accept, call, voicemail (phone and person), block", async () => {
    onTestFailed(() =>
      reportLogs(
        running.map((r) => r.log),
        "new → old failed",
      ),
    );
    const carol = await signUp(current, "carol", "Carol");
    const dave = await signUp(old, "dave", "Dave");
    await knockAndAccept(carol, dave);
    await callAcross(carol, dave);
    await voicemailAcross(carol, dave);
    await noAnswerAcross(carol, dave);
    await block(carol, dave);
  }, 120_000);
});
