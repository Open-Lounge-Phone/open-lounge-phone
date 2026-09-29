import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedIo } from "./io.ts";
import { buildContext, REPO_GIT, selfhostFiles, selfhostInit } from "./selfhost.ts";

const fixed = (n: number) => Buffer.alloc(n, 0xab);
const base = { publicUrl: "https://phone.example.com", openSignup: false, context: "." };

describe("selfhostFiles", () => {
  it("only the server by default: no relay services, no profiles, no secrets", () => {
    const f = selfhostFiles({ ...base, coturn: false, livekit: false }, fixed);
    expect(f.compose).toContain("openloungephone:");
    expect(f.compose).not.toContain("coturn:");
    expect(f.compose).not.toContain("livekit:");
    expect(f.env).toContain("PUBLIC_URL=https://phone.example.com");
    expect(f.env).not.toContain("COMPOSE_PROFILES");
    expect(f.env).toMatch(/^# OPEN_SIGNUP=1$/m);
    expect(f.env).not.toMatch(/^TURN_SECRET=/m);
  });

  it("coturn and LiveKit as profiles, turned on in .env, with random secrets", () => {
    const f = selfhostFiles({ ...base, coturn: true, livekit: true, openSignup: true }, fixed);
    expect(f.compose).toMatch(/coturn:\n\s+image: coturn\/coturn:[\d.]+\n\s+profiles: \[coturn\]/);
    expect(f.compose).toMatch(
      /livekit:\n\s+image: livekit\/livekit-server:v[\d.]+\n\s+profiles: \[livekit\]/,
    );
    expect(f.env).toMatch(/^COMPOSE_PROFILES=coturn,livekit$/m);
    expect(f.env).toMatch(/^TURN_URLS=turn:phone\.example\.com:3478\?transport=udp,/m);
    expect(f.env).toMatch(/^TURN_SECRET=(ab){32}$/m);
    expect(f.env).toMatch(/^LIVEKIT_API_SECRET=(ab){32}$/m);
    expect(f.env).toMatch(/^LIVEKIT_URL=wss:\/\/livekit\.phone\.example\.com$/m);
    expect(f.env).toMatch(/^OPEN_SIGNUP=1$/m);
  });

  it("secrets differ on every run", () => {
    const a = selfhostFiles({ ...base, coturn: true, livekit: true });
    const b = selfhostFiles({ ...base, coturn: true, livekit: true });
    const secret = (env: string) => /^TURN_SECRET=(.*)$/m.exec(env)?.[1];
    expect(secret(a.env)).toMatch(/^[0-9a-f]{64}$/);
    expect(secret(a.env)).not.toBe(secret(b.env));
  });
});

describe("buildContext", () => {
  it("builds from this checkout when the files are inside it, else from git", () => {
    expect(buildContext("/repo", "/repo")).toBe(".");
    expect(buildContext("/repo/deploy/home", "/repo")).toBe("../..");
    expect(buildContext("/srv/phone", "/repo")).toBe(REPO_GIT);
  });
});

describe("selfhostInit", () => {
  let dir = "";
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes both files (.env private), asks what wasn't given, and prints next steps", async () => {
    dir = mkdtempSync(join(tmpdir(), "olp-cli-"));
    const { io, lines } = scriptedIo(["phone.example.org", "y", "n", "n"]);
    const code = await selfhostInit({ dir, force: false, yes: false }, io, "/nonexistent-repo");
    expect(code).toBe(0);
    const env = readFileSync(join(dir, ".env"), "utf8");
    expect(env).toContain("PUBLIC_URL=https://phone.example.org");
    expect(env).toMatch(/^COMPOSE_PROFILES=coturn$/m);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain(`context: ${REPO_GIT}`);
    expect(lines.join("\n")).toContain("docker compose up -d");
  });

  it("never overwrites without --force", async () => {
    dir = mkdtempSync(join(tmpdir(), "olp-cli-"));
    writeFileSync(join(dir, ".env"), "KEEP=1\n");
    const { io, lines } = scriptedIo([], false);
    expect(await selfhostInit({ dir, force: false, yes: true }, io, "/r")).toBe(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("KEEP=1\n");
    expect(lines.join("\n")).toMatch(/--force/);
    expect(await selfhostInit({ dir, force: true, yes: true }, io, "/r")).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("PUBLIC_URL=http://localhost:8787");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });
});
