// Helpers for end-to-end tests that start their own server processes: free ports, one retry for
// the steps that depend on timing (a process starting up, a timer firing), and server logs that
// are easy to find when something fails (printed, and saved under $OLP_E2E_LOG_DIR in CI).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Runs a timing-sensitive step, and once more if it fails (logged, so a flaky pass is visible
 * in the output). `before` runs ahead of the retry, e.g. to clean up a half-started process.
 */
export async function retryOnce<T>(
  label: string,
  step: (attempt: number) => Promise<T>,
  before?: () => void | Promise<void>,
): Promise<T> {
  try {
    return await step(1);
  } catch (e) {
    console.warn(`[e2e] ${label} failed once; retrying:\n${String(e).slice(0, 2000)}`);
    await before?.();
    return step(2);
  }
}

/** A named process's output, kept whole for the failure report. */
export class ProcLog {
  readonly name: string;
  text = "";
  constructor(name: string) {
    this.name = name;
  }
  add = (d: Buffer | string) => {
    this.text += d.toString();
  };
}

/** Saves every log under $OLP_E2E_LOG_DIR (CI uploads it) and prints the tail of each. */
export function reportLogs(logs: ProcLog[], why: string, tailLines = 60): void {
  const dir = process.env.OLP_E2E_LOG_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  for (const log of logs) {
    if (dir) writeFileSync(join(dir, `${log.name}.log`), log.text);
    const tail = log.text.split("\n").slice(-tailLines).join("\n");
    console.error(`\n===== ${log.name} (last ${tailLines} lines; ${why}) =====\n${tail}`);
  }
}

/** Saves the logs without printing them (the passing case, for comparison in CI). */
export function saveLogs(logs: ProcLog[]): void {
  const dir = process.env.OLP_E2E_LOG_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const log of logs) writeFileSync(join(dir, `${log.name}.log`), log.text);
}
