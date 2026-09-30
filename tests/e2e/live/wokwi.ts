// The firmware in the Wokwi simulator, driven over its serial console: `wokwi-cli --interactive`
// forwards stdin to the simulated UART, so the test types console commands (`hook up`, `key 1`,
// `drop`, `screen`) and reads the log (`STATE incall`, `STRIP [..]`, `-> {..}`, `<- {..}`).
// The token comes from $WOKWI_CLI_TOKEN or firmware/.wokwi-token and is never printed.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const FIRMWARE = resolve(import.meta.dirname, "../../../firmware");

function wokwiCli(): string {
  if (process.env.OLP_WOKWI_CLI) return process.env.OLP_WOKWI_CLI;
  const local = join(homedir(), ".local/bin/wokwi-cli");
  return existsSync(local) ? local : "wokwi-cli";
}

function token(): string {
  if (process.env.WOKWI_CLI_TOKEN) return process.env.WOKWI_CLI_TOKEN;
  const file = join(FIRMWARE, ".wokwi-token");
  if (!existsSync(file))
    throw new Error("no Wokwi token: set WOKWI_CLI_TOKEN or firmware/.wokwi-token");
  return readFileSync(file, "utf8").trim();
}

/** Builds the simulator firmware (firmware/tools/sim.sh build). */
export function buildSimFirmware(): void {
  const r = spawnSync(join(FIRMWARE, "tools/sim.sh"), ["build"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sim build failed:\n${r.stdout}\n${r.stderr}`);
}

export class WokwiPhone {
  private proc?: ChildProcess;
  /** Everything the simulation printed (serial + wokwi-cli status lines). */
  log = "";
  /** Where the next `waitFor` starts looking. */
  cursor = 0;
  exited: number | null | undefined;
  readonly logFile: string;

  constructor(logFile: string) {
    this.logFile = logFile;
  }

  /** Starts a simulation (at most ~5 minutes on the current Wokwi plan). */
  start(timeoutMs = 295_000): void {
    this.proc = spawn(
      wokwiCli(),
      [join(FIRMWARE, "wokwi"), "--interactive", "--timeout", String(timeoutMs)],
      { env: { ...process.env, WOKWI_CLI_TOKEN: token() }, stdio: ["pipe", "pipe", "pipe"] },
    );
    const add = (d: Buffer) => {
      this.log += d.toString("utf8");
    };
    this.proc.stdout?.on("data", add);
    this.proc.stderr?.on("data", add);
    this.proc.on("exit", (code) => {
      this.exited = code;
    });
  }

  /** Types a console command. */
  send(command: string): void {
    this.proc?.stdin?.write(`${command}\n`);
  }

  /** Waits for `re` in the output after the cursor; moves the cursor past the match. */
  async waitFor(re: RegExp, timeoutMs = 60_000, label = String(re)): Promise<RegExpExecArray> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const rest = this.log.slice(this.cursor);
      const m = re.exec(rest);
      if (m) {
        this.cursor += m.index + m[0].length;
        return m;
      }
      if (this.exited !== undefined) {
        throw new Error(`simulation ended (exit ${this.exited}) before ${label}${this.tail()}`);
      }
      if (/API Error: Connection timed out after 5 minutes/.test(this.log)) {
        throw new Error(`Wokwi's 5-minute limit hit before ${label}`);
      }
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}${this.tail()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /** True if `re` appears after `from` (without moving the cursor). */
  seenSince(from: number, re: RegExp): boolean {
    return re.test(this.log.slice(from));
  }

  /** Dumps the display (`screen`) and returns the framebuffer rows as hex lines. */
  async screen(): Promise<string> {
    this.send("screen");
    const m = await this.waitFor(/FB \d+ \d+\r?\n[\s\S]*?FB END/, 30_000, "framebuffer dump");
    return m[0];
  }

  private tail(): string {
    return `\n--- last output ---\n${this.log.slice(-1500)}`;
  }

  async stop(): Promise<void> {
    writeFileSync(this.logFile, this.log);
    if (this.proc && this.exited === undefined) {
      this.proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
