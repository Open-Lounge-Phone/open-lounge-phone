import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DeployOptions } from "./args.ts";
import { deployCloudflare, parseWhoami, planDeploy, secretsFromEnv } from "./deploy.ts";
import type { Run } from "./doctor.ts";
import { scriptedIo } from "./io.ts";

const opts: DeployOptions = {
  ai: true,
  refuseRecordedCalls: false,
  newSetupToken: false,
  yes: true,
  dryRun: false,
};
const plan = (over: Partial<Parameters<typeof planDeploy>[0]> = {}) =>
  planDeploy({
    instance: "home",
    domain: "phone.example.com",
    openSignup: false,
    opts,
    secrets: {},
    ...over,
  });

describe("planDeploy", () => {
  it("names only openloungephone-* resources and keeps secrets out of the arguments", () => {
    const p = plan({
      secrets: { turnKeyId: "tid", turnKeyToken: "ttok", sfuAppId: "sid", sfuAppSecret: "ssec" },
    });
    if ("error" in p) throw new Error(p.error);
    expect([p.worker, p.database, p.bucket]).toEqual([
      "openloungephone-home",
      "openloungephone-home",
      "openloungephone-home-voicemail",
    ]);
    expect(p.args).toEqual(["--instance", "home", "--domain", "phone.example.com"]);
    expect(p.args.join(" ")).not.toMatch(/tid|ttok|sid|ssec/);
    expect(p.env).toEqual({
      TURN_KEY_ID: "tid",
      TURN_KEY_API_TOKEN: "ttok",
      SFU_APP_ID: "sid",
      SFU_APP_SECRET: "ssec",
    });
    expect(p.summary.join("\n")).not.toMatch(/ttok|ssec/);
  });

  it("passes the options on", () => {
    const p = plan({
      openSignup: true,
      secrets: { turnKeyId: "a", turnKeyToken: "b" },
      opts: { ...opts, ai: false, fairUse: "none", operator: "jesse,ops", fundingBalance: "150" },
    });
    if ("error" in p) throw new Error(p.error);
    expect(p.args).toEqual([
      "--instance",
      "home",
      "--domain",
      "phone.example.com",
      "--no-ai",
      "--open-signup",
      "--fair-use",
      "none",
      "--operator",
      "jesse,ops",
      "--funding-balance",
      "150",
    ]);
  });

  it("refuses bad names, half-given secrets, and open sign-up without TURN", () => {
    expect(plan({ instance: "Home!" })).toHaveProperty("error");
    expect(plan({ instance: "a".repeat(32) })).toHaveProperty("error");
    expect(plan({ domain: "localhost" })).toHaveProperty("error");
    expect(plan({ secrets: { turnKeyId: "only" } })).toHaveProperty("error");
    expect(plan({ secrets: { sfuAppSecret: "only" } })).toHaveProperty("error");
    expect(plan({ openSignup: true })).toHaveProperty("error", expect.stringMatching(/TURN/));
    // TURN from an earlier deploy is enough.
    expect(plan({ openSignup: true, previous: { turnSet: true } })).not.toHaveProperty("error");
    expect(plan({ opts: { ...opts, sponsorUrl: "http://x" } })).toHaveProperty("error");
    expect(plan({ opts: { ...opts, fundingBalance: "lots" } })).toHaveProperty("error");
  });
});

describe("secrets and accounts", () => {
  it("reads secrets from the environment", () => {
    expect(secretsFromEnv({ TURN_KEY_ID: " x ", TURN_KEY_API_TOKEN: "y", SFU_APP_ID: "" })).toEqual(
      {
        turnKeyId: "x",
        turnKeyToken: "y",
      },
    );
  });

  it("parses wrangler whoami --json", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(parseWhoami(JSON.stringify({ loggedIn: true, accounts: [{ id, name: "Me" }] }))).toEqual(
      {
        loggedIn: true,
        accounts: [{ id, name: "Me" }],
      },
    );
    expect(parseWhoami("not json")).toEqual({ loggedIn: false, accounts: [] });
  });
});

describe("deployCloudflare", () => {
  const id = "0123456789abcdef0123456789abcdef";
  // A stand-in checkout: built web apps, no earlier instances (nothing from this machine).
  const repoRoot = mkdtempSync(join(tmpdir(), "olp-cli-repo-"));
  for (const d of ["apps/companion/dist", "apps/device-web/dist", "apps/server-cloudflare"]) {
    mkdirSync(join(repoRoot, d), { recursive: true });
  }
  afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));
  const whoami =
    (accounts: { id: string; name: string }[], loggedIn = true): Run =>
    () => ({ code: 0, out: `noise ${JSON.stringify({ loggedIn, accounts })}` });

  it("runs the preflight, shows a summary, and passes secrets only in the environment", async () => {
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    // TURN id and token, no SFU app, then confirm with the default.
    const { io, lines, remaining } = scriptedIo(["tid", "ttok", "", ""]);
    const code = await deployCloudflare(
      { ...opts, yes: false, instance: "home", domain: "phone.example.com", openSignup: false },
      io,
      {
        repoRoot,
        run: whoami([{ id, name: "Me" }]),
        env: {},
        exec: async (args, env) => {
          calls.push({ args, env });
          return 0;
        },
        fetch: async () => Response.json({ ok: true }),
      },
    );
    const text = lines.join("\n");
    if (code !== 0) throw new Error(text);
    expect(remaining).toEqual([]);
    expect(text).toContain("openloungephone-home-voicemail");
    expect(text).not.toContain("ttok");
    expect(calls).toEqual([
      {
        args: ["--instance", "home", "--domain", "phone.example.com"],
        env: { TURN_KEY_ID: "tid", TURN_KEY_API_TOKEN: "ttok", CLOUDFLARE_ACCOUNT_ID: id },
      },
    ]);
  });

  it("stops before deploying: not logged in, several accounts, or a dry run", async () => {
    const deps = (run: Run) => ({
      repoRoot,
      run,
      env: {},
      exec: async () => {
        throw new Error("must not deploy");
      },
    });
    const o = { ...opts, instance: "home", domain: "phone.example.com" };
    const out = scriptedIo([], false);
    expect(await deployCloudflare(o, out.io, deps(whoami([], false)))).toBe(1);
    expect(out.lines.join("\n")).toMatch(/wrangler login/);
    const two = scriptedIo([], false);
    const accounts = [
      { id, name: "A" },
      { id: id.replace("0", "f"), name: "B" },
    ];
    expect(await deployCloudflare(o, two.io, deps(whoami(accounts)))).toBe(1);
    expect(two.lines.join("\n")).toMatch(/CLOUDFLARE_ACCOUNT_ID/);
    const dry = scriptedIo([], false);
    expect(
      await deployCloudflare({ ...o, dryRun: true }, dry.io, deps(whoami(accounts.slice(0, 1)))),
    ).toBe(0);
    expect(dry.lines.join("\n")).toMatch(/Dry run/);
    // Without a build it stops at the first preflight step.
    const bare = mkdtempSync(join(tmpdir(), "olp-cli-bare-"));
    const nb = scriptedIo([], false);
    expect(await deployCloudflare(o, nb.io, { ...deps(whoami(accounts)), repoRoot: bare })).toBe(1);
    expect(nb.lines.join("\n")).toMatch(/npm run build/);
    rmSync(bare, { recursive: true, force: true });
  });
});
