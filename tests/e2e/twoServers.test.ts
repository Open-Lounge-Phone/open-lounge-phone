// Two self-host server processes on different host names (a.localhost, b.localhost; *.localhost
// is loopback) federate with each other: the interop scenario from docs/federation.md.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, it } from "vitest";
import {
  block,
  callAcross,
  knockAndAccept,
  type ServerTarget,
  signUp,
  voicemailAcross,
} from "./twoServers.ts";

const MAIN = fileURLToPath(new URL("../../apps/server-selfhost/src/main.ts", import.meta.url));
const running: { proc: ChildProcess; dir: string }[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function launch(name: string): Promise<ServerTarget> {
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push({ proc, dir });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} didn't start:\n${log}`)), 15_000);
    const onData = (d: Buffer) => {
      log += d.toString();
      if (log.includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`${name} exited ${code}:\n${log}`)));
  });
  return { base: `http://127.0.0.1:${port}`, origin };
}

let a: ServerTarget;
let b: ServerTarget;

beforeAll(async () => {
  [a, b] = await Promise.all([launch("a"), launch("b")]);
}, 30_000);

afterAll(() => {
  for (const { proc, dir } of running) {
    proc.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

it("two servers: sign up on each, knock, accept, call, voicemail, block", async () => {
  const jesse = await signUp(a, "jesse", "Jesse");
  const bob = await signUp(b, "bob", "Bob");
  await knockAndAccept(jesse, bob);
  await callAcross(jesse, bob);
  await voicemailAcross(jesse, bob);
  await block(jesse, bob);
}, 60_000);
