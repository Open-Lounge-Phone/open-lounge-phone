// `openloungephone deploy cloudflare`: prompts, a preflight, and a summary around
// apps/server-cloudflare/scripts/deploy.ts (which does the work and stays usable on its own).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DeployOptions } from "./args.ts";
import type { Run } from "./doctor.ts";
import type { Io } from "./io.ts";
import { checkStatus, formatStatus } from "./status.ts";

export const INSTANCE_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
export const DOMAIN_RE =
  /^(?=.{4,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
/** Every Cloudflare resource this tool creates or touches is named like this. */
export const RESOURCE_RE = /^openloungephone-[a-z0-9][a-z0-9-]*$/;

/** Secrets for the instance: from the environment or prompts, never from flags. */
export interface Secrets {
  turnKeyId?: string;
  turnKeyToken?: string;
  sfuAppId?: string;
  sfuAppSecret?: string;
  turnstileSiteKey?: string;
  turnstileSecret?: string;
}

/** What an earlier deploy of this instance recorded (instances/<name>.json, gitignored). */
export interface PreviousState {
  domain?: string;
  turnSet?: boolean;
  sfuSet?: boolean;
  turnstileSet?: boolean;
  setupTokenSet?: boolean;
}

export interface Resolved {
  instance: string;
  domain: string;
  openSignup: boolean;
  opts: DeployOptions;
  secrets: Secrets;
  previous?: PreviousState;
  /** instances/sfu.env exists (scripts/deploy.ts reads the SFU app from it). */
  sfuFile?: boolean;
}

export interface DeployPlan {
  worker: string;
  database: string;
  bucket: string;
  /** Arguments for scripts/deploy.ts: never a secret. */
  args: string[];
  /** Secrets for scripts/deploy.ts's environment (it passes them to wrangler on stdin). */
  env: Record<string, string>;
  summary: string[];
}

export function secretsFromEnv(env: NodeJS.ProcessEnv): Secrets {
  const pick = (k: string) => env[k]?.trim() || undefined;
  const s: Secrets = {};
  const set = (key: keyof Secrets, name: string) => {
    const v = pick(name);
    if (v) s[key] = v;
  };
  set("turnKeyId", "TURN_KEY_ID");
  set("turnKeyToken", "TURN_KEY_API_TOKEN");
  set("sfuAppId", "SFU_APP_ID");
  set("sfuAppSecret", "SFU_APP_SECRET");
  set("turnstileSiteKey", "TURNSTILE_SITE_KEY");
  set("turnstileSecret", "TURNSTILE_SECRET");
  return s;
}

/** Checks everything that can be checked offline and lays out the deploy. Pure. */
export function planDeploy(r: Resolved): DeployPlan | { error: string } {
  const { instance, domain, opts, secrets: s, previous } = r;
  if (!INSTANCE_RE.test(instance)) {
    return { error: `instance name "${instance}": use a-z, 0-9 and -, at most 31 characters` };
  }
  if (!DOMAIN_RE.test(domain)) return { error: `"${domain}" isn't a domain name` };
  const worker = `openloungephone-${instance}`;
  const database = `openloungephone-${instance}`;
  const bucket = `openloungephone-${instance}-voicemail`;
  for (const name of [worker, database, bucket]) {
    if (!RESOURCE_RE.test(name))
      return { error: `refusing a resource name outside openloungephone-*: ${name}` };
  }
  const pair = (a?: string, b?: string) => !!a === !!b;
  if (!pair(s.turnKeyId, s.turnKeyToken))
    return { error: "TURN needs both the key id and its API token" };
  if (!pair(s.sfuAppId, s.sfuAppSecret))
    return { error: "the SFU needs both the app id and its secret" };
  if (!pair(s.turnstileSiteKey, s.turnstileSecret)) {
    return { error: "Turnstile needs both the site key and the secret" };
  }
  const turn = !!s.turnKeyId || previous?.turnSet === true;
  if (r.openSignup && !turn) {
    return {
      error:
        "an open instance needs TURN so people on different networks can talk: set TURN_KEY_ID " +
        "and TURN_KEY_API_TOKEN (dashboard → Realtime → TURN) or answer the prompt",
    };
  }
  if (opts.sponsorUrl && !/^https:\/\/\S+$/.test(opts.sponsorUrl)) {
    return { error: "--sponsor-url must be an https:// link" };
  }
  if (opts.fundingBalance !== undefined && !Number.isFinite(Number(opts.fundingBalance))) {
    return { error: "--funding-balance must be a number of US dollars" };
  }
  if (opts.operator && !/^[a-z0-9._-]{2,30}(,[a-z0-9._-]{2,30})*$/.test(opts.operator)) {
    return { error: "--operator takes handles separated by commas" };
  }
  const args = ["--instance", instance, "--domain", domain];
  if (!opts.ai) args.push("--no-ai");
  if (r.openSignup) args.push("--open-signup");
  if (opts.fairUse) args.push("--fair-use", opts.fairUse);
  if (opts.refuseRecordedCalls) args.push("--refuse-recorded-calls");
  if (opts.newSetupToken) args.push("--new-setup-token");
  if (opts.operator) args.push("--operator", opts.operator);
  if (opts.sponsorUrl) args.push("--sponsor-url", opts.sponsorUrl);
  if (opts.fundingBalance !== undefined) args.push("--funding-balance", opts.fundingBalance);
  const env: Record<string, string> = {};
  if (s.turnKeyId && s.turnKeyToken) {
    env.TURN_KEY_ID = s.turnKeyId;
    env.TURN_KEY_API_TOKEN = s.turnKeyToken;
  }
  if (s.sfuAppId && s.sfuAppSecret) {
    env.SFU_APP_ID = s.sfuAppId;
    env.SFU_APP_SECRET = s.sfuAppSecret;
  }
  if (s.turnstileSiteKey && s.turnstileSecret) {
    env.TURNSTILE_SITE_KEY = s.turnstileSiteKey;
    env.TURNSTILE_SECRET = s.turnstileSecret;
  }
  const state = (now: boolean, before?: boolean) =>
    now ? "set now" : before ? "kept from the last deploy" : "not set";
  const summary = [
    `Instance        ${instance}${previous ? " (updating an earlier deploy)" : " (new)"}`,
    `URL             https://${domain}`,
    `Worker          ${worker}`,
    `D1 database     ${database}`,
    `R2 bucket       ${bucket}`,
    `Sign-up         ${r.openSignup ? `open (fair use: ${opts.fairUse ?? "hub"})` : "invite-only"}`,
    `Transcripts     ${opts.ai ? "Workers AI (billed per audio minute)" : "off"}`,
    `TURN relay      ${state(!!s.turnKeyId, previous?.turnSet)}`,
    `Rooms relay     ${
      s.sfuAppId
        ? "set now"
        : r.sfuFile
          ? "from instances/sfu.env"
          : previous?.sfuSet
            ? "kept from the last deploy"
            : "not set (rooms are peer to peer, up to 4 people)"
    }`,
    ...(r.openSignup
      ? [`Turnstile       ${state(!!s.turnstileSiteKey, previous?.turnstileSet)}`]
      : []),
    ...(opts.operator ? [`Operators       ${opts.operator}`] : []),
  ];
  return { worker, database, bucket, args, env, summary };
}

interface Account {
  id: string;
  name: string;
}

/** Parses `wrangler whoami --json`. */
export function parseWhoami(text: string): { loggedIn: boolean; accounts: Account[] } {
  try {
    const j = JSON.parse(text) as {
      loggedIn?: boolean;
      accounts?: { id?: string; name?: string }[];
    };
    const accounts = (j.accounts ?? [])
      .filter((a) => typeof a.id === "string" && /^[0-9a-f]{32}$/.test(a.id))
      .map((a) => ({ id: a.id as string, name: a.name ?? "" }));
    return { loggedIn: j.loggedIn === true, accounts };
  } catch {
    return { loggedIn: false, accounts: [] };
  }
}

function readPrevious(cfDir: string, instance: string): PreviousState | undefined {
  const file = join(cfDir, "instances", `${instance}.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as PreviousState;
  } catch {
    return undefined;
  }
}

export interface DeployDeps {
  repoRoot: string;
  run: Run;
  env: NodeJS.ProcessEnv;
  /** Runs scripts/deploy.ts; resolves to its exit code. */
  exec(args: string[], env: Record<string, string>): Promise<number>;
  fetch?: (req: Request) => Promise<Response>;
}

export function execDeployScript(repoRoot: string) {
  return (args: string[], env: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["scripts/deploy.ts", ...args], {
        cwd: join(repoRoot, "apps/server-cloudflare"),
        env: { ...process.env, ...env },
        stdio: "inherit",
      });
      child.on("exit", (code) => resolve(code ?? 1));
    });
}

export async function deployCloudflare(opts: DeployOptions, io: Io, deps: DeployDeps) {
  const ask = io.interactive && !opts.yes;
  const cfDir = join(deps.repoRoot, "apps/server-cloudflare");
  const fail = (msg: string) => {
    io.err(msg);
    return 1;
  };

  // --- what to deploy ---------------------------------------------------------------
  let instance = opts.instance;
  if (!instance && ask)
    instance = (await io.ask("Instance name (a-z, 0-9, -)", "home")).toLowerCase();
  if (!instance) return fail("--instance is required (or run it interactively)");
  const previous = readPrevious(cfDir, instance);
  let domain = opts.domain;
  if (!domain && ask)
    domain = (
      await io.ask("Domain (a zone in your Cloudflare account)", previous?.domain)
    ).toLowerCase();
  domain ??= previous?.domain;
  if (!domain) return fail("--domain is required (or run it interactively)");
  let openSignup = opts.openSignup;
  if (openSignup === undefined && ask) {
    openSignup = await io.confirm("Let anyone create an account (a public hub)?", false);
  }
  openSignup ??= false;

  const secrets = secretsFromEnv(deps.env);
  const sfuFile = existsSync(join(cfDir, "instances", "sfu.env"));
  if (ask) {
    if (!secrets.turnKeyId && !previous?.turnSet) {
      io.out(
        openSignup
          ? "An open instance needs a TURN key (dashboard → Realtime → TURN)."
          : "Optional: a TURN key relays calls between networks (dashboard → Realtime → TURN).",
      );
      const id = await io.askSecret("TURN key id");
      if (id) {
        secrets.turnKeyId = id;
        secrets.turnKeyToken = await io.askSecret("TURN key API token");
      }
    }
    if (!secrets.sfuAppId && !previous?.sfuSet && !sfuFile) {
      io.out(
        "Optional: an SFU app relays rooms of more than 4 people (dashboard → Realtime → SFU).",
      );
      const id = await io.askSecret("SFU app id");
      if (id) {
        secrets.sfuAppId = id;
        secrets.sfuAppSecret = await io.askSecret("SFU app secret");
      }
    }
    if (openSignup && !secrets.turnstileSiteKey && !previous?.turnstileSet) {
      io.out("Recommended for open sign-up: Turnstile (dashboard → Turnstile → add a widget).");
      const site = await io.askSecret("Turnstile site key");
      if (site) {
        secrets.turnstileSiteKey = site;
        secrets.turnstileSecret = await io.askSecret("Turnstile secret");
      }
    }
  }
  const plan = planDeploy({
    instance,
    domain,
    openSignup,
    opts,
    secrets,
    sfuFile,
    ...(previous ? { previous } : {}),
  });
  if ("error" in plan) return fail(plan.error);

  // --- preflight ---------------------------------------------------------------------
  io.out("Preflight");
  const built = ["apps/companion/dist", "apps/device-web/dist"].every((d) =>
    existsSync(join(deps.repoRoot, d)),
  );
  if (!built)
    return fail("  ✘ The web apps aren't built: run `npm run build` at the repository root.");
  io.out("  ✔ web apps built");
  const who = deps.run("npx", ["--no-install", "wrangler", "whoami", "--json"], cfDir);
  const me = parseWhoami(who.out.slice(who.out.indexOf("{")));
  if (!me.loggedIn) return fail("  ✘ wrangler isn't logged in: run `npx wrangler login` first.");
  let accountId = deps.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (accountId && !me.accounts.some((a) => a.id === accountId)) {
    return fail(`  ✘ CLOUDFLARE_ACCOUNT_ID ${accountId} isn't one of your accounts.`);
  }
  if (!accountId) {
    if (me.accounts.length === 1) accountId = me.accounts[0]?.id;
    else if (me.accounts.length > 1 && ask) {
      for (const [i, a] of me.accounts.entries()) io.out(`    ${i + 1}. ${a.name} (${a.id})`);
      const n = Number(await io.ask("Which account", "1"));
      accountId = me.accounts[n - 1]?.id;
    }
  }
  if (!accountId) {
    return fail("  ✘ Several Cloudflare accounts: set CLOUDFLARE_ACCOUNT_ID to the one to use.");
  }
  const account = me.accounts.find((a) => a.id === accountId);
  io.out(`  ✔ logged in; account ${account?.name ?? ""} (${accountId})`);
  io.out(`  ✔ only openloungephone-* resources: ${plan.worker}, ${plan.bucket}`);

  io.out();
  io.out("Summary");
  for (const line of plan.summary) io.out(`  ${line}`);
  io.out();
  if (opts.dryRun) {
    io.out("Dry run: nothing was created or deployed.");
    return 0;
  }
  if (ask && !(await io.confirm("Deploy now?", true))) return fail("Cancelled.");

  const code = await deps.exec(plan.args, { ...plan.env, CLOUDFLARE_ACCOUNT_ID: accountId });
  if (code !== 0)
    return fail(`Deploy failed (exit ${code}); nothing else was changed after that step.`);
  io.out();
  io.out("Checking the new deployment…");
  const report = await checkStatus(`https://${domain}`, deps.fetch);
  for (const l of formatStatus(report)) io.out(`  ${l}`);
  if (!report.healthy) {
    io.out("  (A new custom domain can take a minute or two for DNS and its certificate.)");
  }
  return 0;
}
