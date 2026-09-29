// `openloungephone doctor`: what this machine has for running or deploying a server.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "./io.ts";

export interface Check {
  name: string;
  ok: boolean;
  /** A failed required check makes `doctor` exit 1; optional ones only warn. */
  required: boolean;
  detail: string;
}

export type Run = (cmd: string, args: string[], cwd?: string) => { code: number; out: string };

export const runCommand: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 20_000 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

export function nodeCheck(version: string): Check {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return {
    name: "Node.js",
    ok,
    required: true,
    detail: ok ? version : `${version}; needs 22.18 or newer (runs TypeScript directly)`,
  };
}

export function runChecks(repoRoot: string, run: Run = runCommand): Check[] {
  const checks: Check[] = [nodeCheck(process.version)];
  const installed = existsSync(join(repoRoot, "node_modules", "wrangler"));
  checks.push({
    name: "npm install",
    ok: installed,
    required: true,
    detail: installed ? "dependencies installed" : "run `npm install` at the repository root",
  });
  const built = ["apps/companion/dist", "apps/device-web/dist"].every((d) =>
    existsSync(join(repoRoot, d)),
  );
  checks.push({
    name: "web apps built",
    ok: built,
    required: false,
    detail: built
      ? "companion and emulator built"
      : "run `npm run build` (needed to deploy or start)",
  });
  const cfDir = join(repoRoot, "apps/server-cloudflare");
  if (installed) {
    const w = run("npx", ["--no-install", "wrangler", "--version"], cfDir);
    checks.push({
      name: "wrangler",
      ok: w.code === 0,
      required: false,
      detail: w.code === 0 ? firstLine(w.out) : "not runnable (needed for Cloudflare)",
    });
    if (w.code === 0) {
      const who = run("npx", ["--no-install", "wrangler", "whoami", "--json"], cfDir);
      const logged = who.code === 0 && /"loggedIn":\s*true/.test(who.out);
      checks.push({
        name: "Cloudflare login",
        ok: logged,
        required: false,
        detail: logged ? "logged in" : "run `npx wrangler login` to deploy to Cloudflare",
      });
    }
  }
  const docker = run("docker", ["--version"]);
  checks.push({
    name: "Docker",
    ok: docker.code === 0,
    required: false,
    detail:
      docker.code === 0 ? firstLine(docker.out) : "not found (needed to self-host with Docker)",
  });
  if (docker.code === 0) {
    const compose = run("docker", ["compose", "version"]);
    checks.push({
      name: "Docker Compose",
      ok: compose.code === 0,
      required: false,
      detail: compose.code === 0 ? firstLine(compose.out) : "`docker compose` isn't available",
    });
    const daemon = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    checks.push({
      name: "Docker daemon",
      ok: daemon.code === 0,
      required: false,
      detail:
        daemon.code === 0 ? `running (${firstLine(daemon.out)})` : "not running; start Docker",
    });
  }
  return checks;
}

export function doctor(io: Io, repoRoot: string, run?: Run): number {
  const checks = runChecks(repoRoot, run);
  for (const c of checks) {
    const mark = c.ok ? "✔" : c.required ? "✘" : "!";
    io.out(`${mark} ${c.name.padEnd(17)}${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && c.required);
  io.out();
  io.out(
    failed.length
      ? `${failed.length} required check(s) failed.`
      : "Ready. Warnings (!) only matter for the feature named.",
  );
  return failed.length ? 1 : 0;
}
