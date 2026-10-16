// Shared by the live add-on tests: a local self-hosted server with add-ons on, Python add-ons
// from sdk/python/examples as processes, and Chromium (playwright-core). Nothing external.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";
import { freePort, ProcLog } from "../procs.ts";
import { api, type Person, type ServerTarget } from "../twoServers.ts";
import { CHROMIUM_ARGS, until } from "./browser.ts";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAIN = join(ROOT, "apps/server-selfhost/src/main.ts");
export const PYTHON = process.env.OLP_ADDON_PYTHON ?? join(ROOT, "sdk/python/.venv/bin/python");

export class AddonLab {
  server!: ServerTarget;
  host = "";
  browser!: Browser;
  readonly logs: ProcLog[] = [];
  private proc?: ChildProcess;
  private dataDir = "";
  private readonly kids: ChildProcess[] = [];
  private readonly dirs: string[] = [];

  /** Builds the web apps (unless OLP_ADDON_NO_BUILD=1), starts the server and Chromium. */
  async start(
    env: Record<string, string> = {},
    /** Runs on the empty data folder before the server starts (e.g. to seed an operator). */
    prepare?: (dataDir: string) => void | Promise<void>,
  ): Promise<void> {
    if (process.env.OLP_ADDON_NO_BUILD !== "1") {
      for (const w of ["@openloungephone/companion", "@openloungephone/device-web"]) {
        const b = spawnSync("npm", ["run", "build", "-w", w], { cwd: ROOT, encoding: "utf8" });
        if (b.status !== 0) throw new Error(`${w} build failed:\n${b.stderr}`);
      }
    }
    const port = await freePort();
    this.dataDir = mkdtempSync(join(tmpdir(), "olp-addon-lab-"));
    await prepare?.(this.dataDir);
    const origin = `http://localhost:${port}`;
    const log = new ProcLog("selfhost");
    this.logs.push(log);
    this.proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", MAIN], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        PUBLIC_URL: origin,
        DATA_DIR: this.dataDir,
        OPEN_SIGNUP: "1",
        ADDONS: "on",
        STUN_URLS: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc.stdout?.on("data", log.add);
    this.proc.stderr?.on("data", log.add);
    await until("the server listening", () => log.text.includes("listening on"), 20_000);
    this.server = { base: origin, origin };
    this.host = new URL(origin).host;
    const pw = await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
    const chromium = pw.chromium ?? pw.default?.chromium;
    this.browser = (await chromium.launch({
      headless: true,
      args: CHROMIUM_ARGS,
      ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
    })) as Browser;
  }

  async stop(): Promise<void> {
    for (const p of this.kids) p.kill("SIGTERM");
    await this.browser?.close();
    this.proc?.kill("SIGTERM");
    for (const d of [this.dataDir, ...this.dirs])
      if (d) rmSync(d, { recursive: true, force: true });
  }

  /** A new key file for an add-on (in its own temporary folder). */
  keyFile(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "olp-addon-key-"));
    this.dirs.push(dir);
    return join(dir, `${name}.addon-key`);
  }

  /** Runs `sdk/python/examples/<script>.py` against the server; its log is returned. */
  python(script: string, keyFile: string, extra: string[] = [], name = script): ProcLog {
    const log = new ProcLog(name);
    this.logs.push(log);
    const p = spawn(
      PYTHON,
      [
        join(ROOT, `sdk/python/examples/${script}.py`),
        "--server",
        this.server.base,
        "--key",
        keyFile,
        ...extra,
      ],
      {
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONPATH: join(ROOT, "sdk/python") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    p.stdout?.on("data", log.add);
    p.stderr?.on("data", log.add);
    this.kids.push(p);
    return log;
  }

  /** The link code an add-on process printed. */
  code(log: ProcLog): Promise<string> {
    return until("the add-on's link code", () => /Link code: (\d{6})/.exec(log.text)?.[1], 30_000);
  }

  /** Links an add-on process to `owner` through the API and waits until it's connected. */
  async link(owner: Person, log: ProcLog, name: string): Promise<{ id: string; address: string }> {
    const code = await this.code(log);
    const res = await api(owner, "/addons/link", { body: { code, name } });
    if (res.status !== 201) throw new Error(`link ${res.status} ${JSON.stringify(res.json)}`);
    await until(
      "the add-on connected",
      () => log.text.includes(`ready ${res.json.address}`),
      20_000,
    );
    return { id: res.json.id, address: res.json.address };
  }
}

/** `a` knocks on `b` (same server) and `b` accepts. */
export async function befriend(a: Person, b: Person): Promise<void> {
  const k = await api(a, "/connections", { body: { to: b.address } });
  if (k.status !== 202) throw new Error(`knock ${k.status}`);
  const knock = (await api(b, "/connections")).json.connections.find(
    (c: { address: string }) => c.address === a.address,
  );
  const ok = await api(b, `/connections/${knock.id}/accept`, { method: "POST" });
  if (ok.status !== 200) throw new Error(`accept ${ok.status}`);
}

/** Screenshots at phone width for docs and review (OLP_ADDON_SHOTS=<dir>). */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.OLP_ADDON_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}

/** Counts what a person does: every click, fill and choice in a flow (for step counts). */
export class Steps {
  readonly done: string[] = [];
  step(what: string): void {
    this.done.push(what);
  }
  get count(): number {
    return this.done.length;
  }
}
