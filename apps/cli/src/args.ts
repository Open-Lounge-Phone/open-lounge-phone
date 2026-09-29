// Command-line parsing: argv in, one command out (pure, so it's easy to test).
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

export interface DeployOptions {
  instance?: string;
  domain?: string;
  /** undefined: ask (interactive) or invite-only (non-interactive). */
  openSignup?: boolean;
  ai: boolean;
  fairUse?: "hub" | "none";
  operator?: string;
  sponsorUrl?: string;
  fundingBalance?: string;
  refuseRecordedCalls: boolean;
  newSetupToken: boolean;
  /** Don't ask anything; fail if something required is missing. */
  yes: boolean;
  /** Preflight and summary only; nothing is created or deployed. */
  dryRun: boolean;
}

export interface SelfhostOptions {
  dir: string;
  publicUrl?: string;
  /** undefined: ask (interactive) or off. */
  coturn?: boolean;
  livekit?: boolean;
  openSignup?: boolean;
  force: boolean;
  yes: boolean;
}

export type Command =
  | { kind: "help"; topic?: string }
  | { kind: "version" }
  | { kind: "deploy"; target: "cloudflare"; opts: DeployOptions }
  | { kind: "selfhost-init"; opts: SelfhostOptions }
  | { kind: "status"; url: string; json: boolean }
  | { kind: "doctor" }
  | { kind: "error"; message: string };

/** Secrets never travel on the command line (shell history, `ps`): env vars or prompts only. */
const SECRET_FLAGS = [
  "turn-key-id",
  "turn-key-token",
  "sfu-app-id",
  "sfu-app-secret",
  "turnstile-secret",
];

const err = (message: string): Command => ({ kind: "error", message });

function parse<T extends ParseArgsOptionsConfig>(argv: string[], options: T) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

export function parseCli(argv: string[]): Command {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    return { kind: "help", ...(rest[0] ? { topic: rest[0] } : {}) };
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return { kind: "version" };
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help", topic: cmd };
  const secret = rest.find((a) => SECRET_FLAGS.includes(a.replace(/^--/, "").split("=")[0] ?? ""));
  if (secret) {
    return err(
      `${secret.split("=")[0]}: secrets aren't taken as flags (they'd end up in your shell ` +
        "history). Set TURN_KEY_ID/TURN_KEY_API_TOKEN, SFU_APP_ID/SFU_APP_SECRET or " +
        "TURNSTILE_SECRET in the environment, or answer the prompts.",
    );
  }
  try {
    switch (cmd) {
      case "deploy":
        return parseDeploy(rest);
      case "selfhost":
        return parseSelfhost(rest);
      case "status": {
        const { values, positionals } = parse(rest, { json: { type: "boolean" } });
        const [url, extra] = positionals;
        if (!url || extra) return err("usage: openloungephone status <url>");
        const normalized = normalizeUrl(url);
        if (!normalized) return err(`not a server URL: ${url}`);
        return { kind: "status", url: normalized, json: values.json === true };
      }
      case "doctor": {
        const { positionals } = parse(rest, {});
        if (positionals.length) return err("usage: openloungephone doctor");
        return { kind: "doctor" };
      }
      default:
        return err(`unknown command: ${cmd} (try: openloungephone help)`);
    }
  } catch (e) {
    return err((e as Error).message);
  }
}

function parseDeploy(argv: string[]): Command {
  const { values, positionals } = parse(argv, {
    instance: { type: "string" },
    domain: { type: "string" },
    "open-signup": { type: "boolean" },
    "invite-only": { type: "boolean" },
    "no-ai": { type: "boolean" },
    "fair-use": { type: "string" },
    operator: { type: "string" },
    "sponsor-url": { type: "string" },
    "funding-balance": { type: "string" },
    "refuse-recorded-calls": { type: "boolean" },
    "new-setup-token": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    "dry-run": { type: "boolean" },
  });
  const [target, extra] = positionals;
  if (target !== "cloudflare" || extra) {
    return err(
      "usage: openloungephone deploy cloudflare [options] (see: openloungephone help deploy)",
    );
  }
  if (values["open-signup"] && values["invite-only"]) {
    return err("--open-signup and --invite-only contradict each other");
  }
  const fairUse = values["fair-use"];
  if (fairUse !== undefined && fairUse !== "hub" && fairUse !== "none") {
    return err("--fair-use must be hub or none");
  }
  const opts: DeployOptions = {
    ai: values["no-ai"] !== true,
    refuseRecordedCalls: values["refuse-recorded-calls"] === true,
    newSetupToken: values["new-setup-token"] === true,
    yes: values.yes === true,
    dryRun: values["dry-run"] === true,
    ...(values.instance !== undefined ? { instance: values.instance } : {}),
    ...(values.domain !== undefined ? { domain: values.domain.toLowerCase() } : {}),
    ...(values["open-signup"] ? { openSignup: true } : {}),
    ...(values["invite-only"] ? { openSignup: false } : {}),
    ...(fairUse ? { fairUse } : {}),
    ...(values.operator !== undefined ? { operator: values.operator } : {}),
    ...(values["sponsor-url"] !== undefined ? { sponsorUrl: values["sponsor-url"] } : {}),
    ...(values["funding-balance"] !== undefined
      ? { fundingBalance: values["funding-balance"] }
      : {}),
  };
  return { kind: "deploy", target: "cloudflare", opts };
}

function parseSelfhost(argv: string[]): Command {
  const { values, positionals } = parse(argv, {
    dir: { type: "string" },
    "public-url": { type: "string" },
    coturn: { type: "boolean" },
    "no-coturn": { type: "boolean" },
    livekit: { type: "boolean" },
    "no-livekit": { type: "boolean" },
    "open-signup": { type: "boolean" },
    force: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
  });
  const [sub, extra] = positionals;
  if (sub !== "init" || extra) {
    return err(
      "usage: openloungephone selfhost init [options] (see: openloungephone help selfhost)",
    );
  }
  const flag = (on: boolean | undefined, off: boolean | undefined) =>
    on ? true : off ? false : undefined;
  if (values.coturn && values["no-coturn"]) return err("--coturn and --no-coturn contradict");
  if (values.livekit && values["no-livekit"]) return err("--livekit and --no-livekit contradict");
  let publicUrl: string | undefined;
  if (values["public-url"] !== undefined) {
    publicUrl = normalizeUrl(values["public-url"]);
    if (!publicUrl) return err(`--public-url: not a URL: ${values["public-url"]}`);
  }
  const coturn = flag(values.coturn, values["no-coturn"]);
  const livekit = flag(values.livekit, values["no-livekit"]);
  const opts: SelfhostOptions = {
    dir: values.dir ?? ".",
    force: values.force === true,
    yes: values.yes === true,
    ...(publicUrl ? { publicUrl } : {}),
    ...(coturn !== undefined ? { coturn } : {}),
    ...(livekit !== undefined ? { livekit } : {}),
    ...(values["open-signup"] ? { openSignup: true } : {}),
  };
  return { kind: "selfhost-init", opts };
}

/**
 * `phone.example.com` → `https://phone.example.com`; keeps an explicit http(s) origin; drops
 * any path. Undefined for anything that isn't a plain http(s) origin.
 */
export function normalizeUrl(text: string): string | undefined {
  const t = text.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) {
      return undefined;
    }
    if (!/^[a-z0-9.-]+$/i.test(u.hostname)) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

export const HELP: Record<string, string> = {
  "": `openloungephone — set up and check Open Lounge Phone servers

Usage:
  openloungephone deploy cloudflare [options]   deploy to your own Cloudflare account
  openloungephone selfhost init [options]       write compose.yaml and .env for Docker
  openloungephone status <url>                  health, discovery and version of a server
  openloungephone doctor                        check this machine (Node, wrangler, Docker)
  openloungephone help <command>                more about one command

Run it from this repository: npx openloungephone … (after npm install), or
node apps/cli/bin/openloungephone.js ….`,
  deploy: `openloungephone deploy cloudflare [options]

Deploys one instance to the Cloudflare account wrangler is logged in to (npx wrangler login).
Asks for anything not given. Creates or reuses only resources named openloungephone-<instance>.

  --instance <name>          instance name (a-z, 0-9, -): Worker openloungephone-<name>
  --domain <host>            custom domain; must be a zone in the same account
  --open-signup              anyone may create an account (a public hub; needs TURN)
  --invite-only              people join by invite only (the default)
  --no-ai                    no Workers AI voicemail transcripts
  --fair-use hub|none        fair-use allowance for an open instance (default hub)
  --operator <handles>       who sees the Operator view (comma-separated)
  --sponsor-url <https://…>  show a Sponsor button
  --funding-balance <usd>    show the funding card
  --refuse-recorded-calls    other servers' recorded calls don't reach your people
  --new-setup-token          issue a new one-time setup link
  --dry-run                  preflight and summary only; change nothing
  -y, --yes                  don't ask; fail if something required is missing

Secrets are never flags. They come from the environment, or are asked for without echo:
  TURN_KEY_ID, TURN_KEY_API_TOKEN   Realtime TURN key (calls across networks)
  SFU_APP_ID, SFU_APP_SECRET        Realtime SFU app (rooms of more than 4)
  TURNSTILE_SITE_KEY, TURNSTILE_SECRET   Turnstile on sign-up
  CLOUDFLARE_ACCOUNT_ID             which account, if you have several`,
  selfhost: `openloungephone selfhost init [options]

Writes compose.yaml and .env (random secrets, mode 600) for Docker Compose, then prints the next
steps. Asks for anything not given.

  --dir <path>             where to write them (default: the current directory)
  --public-url <url>       where people reach the server (default http://localhost:8787)
  --coturn / --no-coturn   bundle a TURN relay (calls across networks)
  --livekit / --no-livekit bundle LiveKit (rooms of more than 4)
  --open-signup            anyone may create an account
  --force                  overwrite existing files
  -y, --yes                don't ask; use the defaults`,
  status: `openloungephone status <url> [--json]

Checks a server: /api/health, /.well-known/openloungephone (federation key and version) and
the software version. Exits 1 if the server isn't healthy.`,
  doctor: `openloungephone doctor

Checks this machine: Node version, this repository's install and build, wrangler (and whether
it's logged in), Docker and Docker Compose.`,
};
