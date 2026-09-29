// Deploys one Open Lounge Phone instance to the Cloudflare account wrangler is logged in to.
//
//   node scripts/deploy.ts --instance l1 --domain l1.openloungephone.app [--no-ai]
//                          [--turn-key-id ID --turn-key-token TOKEN] [--new-setup-token]
//                          [--open-signup] [--fair-use hub|none]
//                          [--turnstile-site-key KEY --turnstile-secret SECRET]
//                          [--operator handle[,handle]] [--sponsor-url URL]
//                          [--funding-balance USD] [--sfu-app-id ID --sfu-app-secret SECRET]
//
// --open-signup lets anyone create an account on the instance (a public hub). Without it the
// instance is invite-only; every deploy sets the flag, so omitting it closes sign-up again.
// A public instance needs TURN (people on different networks must be able to talk), so
// --open-signup refuses to deploy until a TURN key was given (now or on an earlier run). It also
// turns on the hub's fair-use allowance (FAIR_USE=hub; `--fair-use none` for unlimited).
// Turnstile protects sign-up when both keys are given; --operator names who sees the admin view;
// --sponsor-url shows a Sponsor button (hidden while unset); --funding-balance shows the funding
// card (with the hub's cost model, see docs/hub.md).
// --sfu-app-id/--sfu-app-secret give rooms a media relay (Cloudflare Realtime SFU app, dashboard →
// Realtime → SFU), stored as secrets; when not given they're read from instances/sfu.env
// (SFU_APP_ID=…, SFU_APP_SECRET=…, gitignored) if it exists. Without them rooms are peer to peer
// and hold 4 people. 1:1 calls never use the relay.
//
// The public hub:
//   node scripts/deploy.ts --instance hub --domain hub.openloungephone.app --open-signup \
//     --turn-key-id <id> --turn-key-token <token> \
//     --turnstile-site-key <key> --turnstile-secret <secret> \
//     --operator <your handle> --funding-balance 150 [--sponsor-url <GitHub Sponsors URL>]
//
// Idempotent: creates the D1 database and R2 bucket only if missing, applies pending
// migrations, deploys the Worker on the custom domain, and on first run sets a one-time
// SETUP_TOKEN secret and prints the setup link. It also generates the instance's federation key
// (FED_PRIVATE_KEY secret) once — other servers pin it, so it is never regenerated — and sets
// PUBLIC_URL to https://<domain>. Account-specific IDs are written to
// instances/<instance>.json and instances/<instance>.wrangler.jsonc, which are gitignored.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateServerKey } from "@openloungephone/federation";

const APP = fileURLToPath(new URL("..", import.meta.url));
const INSTANCES = `${APP}instances`;

const { values: args } = parseArgs({
  options: {
    instance: { type: "string" },
    domain: { type: "string" },
    "no-ai": { type: "boolean", default: false },
    "turn-key-id": { type: "string" },
    "turn-key-token": { type: "string" },
    "new-setup-token": { type: "boolean", default: false },
    "open-signup": { type: "boolean", default: false },
    "refuse-recorded-calls": { type: "boolean", default: false },
    "fair-use": { type: "string" },
    "turnstile-site-key": { type: "string" },
    "turnstile-secret": { type: "string" },
    operator: { type: "string" },
    "sponsor-url": { type: "string" },
    "funding-balance": { type: "string" },
    "sfu-app-id": { type: "string" },
    "sfu-app-secret": { type: "string" },
  },
});

const instance = args.instance ?? "";
const domain = args.domain ?? "";
if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(instance) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
  console.error("usage: node scripts/deploy.ts --instance <name> --domain <host.example.com>");
  process.exit(2);
}

interface InstanceState {
  instance: string;
  domain: string;
  worker: string;
  database: { name: string; id: string };
  bucket: string;
  ai: boolean;
  openSignup: boolean;
  setupTokenSet: boolean;
  /** FED_PRIVATE_KEY was set (never regenerated: other servers have the public key pinned). */
  fedKeySet?: boolean;
  /** TURN_KEY_ID / TURN_KEY_API_TOKEN were set. */
  turnSet?: boolean;
  turnstileSet?: boolean;
  /** SFU_APP_ID / SFU_APP_SECRET were set (rooms' media relay). */
  sfuSet?: boolean;
}

/** SFU credentials from the flags, else from instances/sfu.env (never printed). */
function sfuCredentials(): { id: string; secret: string } | undefined {
  if (args["sfu-app-id"] && args["sfu-app-secret"]) {
    return { id: args["sfu-app-id"], secret: args["sfu-app-secret"] };
  }
  const file = `${INSTANCES}/sfu.env`;
  if (!existsSync(file)) return undefined;
  const vars = Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
  );
  return vars.SFU_APP_ID && vars.SFU_APP_SECRET
    ? { id: vars.SFU_APP_ID, secret: vars.SFU_APP_SECRET }
    : undefined;
}

const openSignup = args["open-signup"] === true;
const sponsorUrl = args["sponsor-url"]?.trim();
if (sponsorUrl && !/^https:\/\/\S+$/.test(sponsorUrl)) {
  console.error("--sponsor-url must be an https:// link");
  process.exit(2);
}
const funding = args["funding-balance"];
if (funding !== undefined && !Number.isFinite(Number(funding))) {
  console.error("--funding-balance must be a number of US dollars");
  process.exit(2);
}

const statePath = `${INSTANCES}/${instance}.json`;
const configPath = `${INSTANCES}/${instance}.wrangler.jsonc`;
mkdirSync(INSTANCES, { recursive: true });
const previous: Partial<InstanceState> = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};

const turnNow = !!(args["turn-key-id"] && args["turn-key-token"]);
if (openSignup && !turnNow && !previous.turnSet) {
  console.error(
    "A public instance (--open-signup) needs TURN so people on different networks can talk.\n" +
      "Create a TURN key in the Cloudflare dashboard (Realtime → TURN) and pass\n" +
      "--turn-key-id <id> --turn-key-token <token>.",
  );
  process.exit(2);
}

function wrangler(argv: string[], input?: string): string {
  const res = spawnSync("npx", ["wrangler", ...argv], {
    cwd: APP,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    throw new Error(`wrangler ${argv.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

const step = (msg: string) => console.log(`\n▸ ${msg}`);

// --- D1 -----------------------------------------------------------------------------
const dbName = `openloungephone-${instance}`;
step(`D1 database ${dbName}`);
type D1Row = { uuid: string; name: string };
const findDb = () =>
  (JSON.parse(wrangler(["d1", "list", "--json"])) as D1Row[]).find((d) => d.name === dbName);
let db = findDb();
if (!db) {
  wrangler(["d1", "create", dbName]);
  db = findDb();
  if (!db) throw new Error(`created ${dbName} but can't find it`);
  console.log(`  created ${db.uuid}`);
} else {
  console.log(`  exists ${db.uuid}`);
}

// --- R2 -----------------------------------------------------------------------------
const bucket = `openloungephone-${instance}-voicemail`;
step(`R2 bucket ${bucket}`);
if (wrangler(["r2", "bucket", "list"]).includes(`name:           ${bucket}`)) {
  console.log("  exists");
} else {
  wrangler(["r2", "bucket", "create", bucket]);
  console.log("  created");
}

// --- instance wrangler config ---------------------------------------------------------
const ai = !args["no-ai"];
step(`config ${configPath}`);
const base = JSON.parse(
  readFileSync(`${APP}wrangler.jsonc`, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n"),
) as Record<string, unknown> & { assets: Record<string, unknown> };
const worker = `openloungephone-${instance}`;
const config = {
  ...base,
  $schema: "../../../node_modules/wrangler/config-schema.json",
  name: worker,
  main: "../src/index.ts",
  assets: { ...base.assets, directory: "../public" },
  d1_databases: [
    {
      binding: "DB",
      database_name: dbName,
      database_id: db.uuid,
      migrations_dir: "../../../packages/db/migrations",
    },
  ],
  r2_buckets: [{ binding: "BLOBS", bucket_name: bucket }],
  ...(ai ? { ai: { binding: "AI" } } : {}),
  vars: {
    ...(base.vars as object | undefined),
    OPEN_SIGNUP: openSignup ? "1" : "0",
    REFUSE_RECORDED_CALLS: args["refuse-recorded-calls"] === true ? "1" : "0",
    PUBLIC_URL: `https://${domain}`,
    // Public instances get the hub's fair-use allowance unless told otherwise.
    ...(openSignup && args["fair-use"] !== "none" ? { FAIR_USE: "hub" } : {}),
    ...(args["turnstile-site-key"] ? { TURNSTILE_SITE_KEY: args["turnstile-site-key"] } : {}),
    ...(args.operator ? { OPERATORS: args.operator } : {}),
    ...(sponsorUrl ? { SPONSOR_URL: sponsorUrl } : {}),
    ...(funding !== undefined ? { FUNDING_BALANCE_USD: funding } : {}),
  },
  routes: [{ pattern: domain, custom_domain: true }],
  workers_dev: false,
};
writeFileSync(
  configPath,
  `// Generated by scripts/deploy.ts for instance "${instance}". Not committed.\n${JSON.stringify(config, null, 2)}\n`,
);

// --- build + migrate + deploy ---------------------------------------------------------
step("assembling static assets");
const assets = spawnSync("node", ["scripts/assemble-assets.ts"], { cwd: APP, stdio: "inherit" });
if (assets.status !== 0) throw new Error("run `npm run build` at the repository root first");

step("applying D1 migrations (remote)");
console.log(wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", configPath], "y\n"));

step(`deploying ${worker} to https://${domain}`);
console.log(wrangler(["deploy", "-c", configPath]));

// --- secrets ------------------------------------------------------------------------------
let setupToken: string | undefined;
if (!previous.setupTokenSet || args["new-setup-token"]) {
  step("setting one-time SETUP_TOKEN secret");
  setupToken = randomBytes(24).toString("base64url");
  wrangler(["secret", "put", "SETUP_TOKEN", "-c", configPath], setupToken);
}
let fedKeySet = previous.fedKeySet === true;
if (!fedKeySet) {
  step("setting the federation key (FED_PRIVATE_KEY secret, generated once)");
  wrangler(["secret", "put", "FED_PRIVATE_KEY", "-c", configPath], await generateServerKey());
  fedKeySet = true;
}
let turnstileSet = previous.turnstileSet === true;
if (args["turnstile-secret"]) {
  step("setting the Turnstile secret");
  wrangler(["secret", "put", "TURNSTILE_SECRET", "-c", configPath], args["turnstile-secret"]);
  turnstileSet = true;
}
if (turnNow) {
  step("setting TURN secrets");
  wrangler(["secret", "put", "TURN_KEY_ID", "-c", configPath], args["turn-key-id"]);
  wrangler(["secret", "put", "TURN_KEY_API_TOKEN", "-c", configPath], args["turn-key-token"]);
}

const sfu = sfuCredentials();
if (sfu) {
  step("setting the rooms' media relay (SFU) secrets");
  wrangler(["secret", "put", "SFU_APP_ID", "-c", configPath], sfu.id);
  wrangler(["secret", "put", "SFU_APP_SECRET", "-c", configPath], sfu.secret);
}

const state: InstanceState = {
  instance,
  domain,
  worker,
  database: { name: dbName, id: db.uuid },
  bucket,
  ai,
  openSignup,
  setupTokenSet: previous.setupTokenSet || setupToken !== undefined,
  fedKeySet,
  turnSet: previous.turnSet === true || turnNow,
  turnstileSet,
  sfuSet: previous.sfuSet === true || !!sfu,
};
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

console.log(`\n✔ Open Lounge Phone "${instance}" is live at https://${domain}`);
console.log(
  openSignup
    ? "  Open sign-up is ON: anyone can create an account (fair-use allowance applies)."
    : "  Invite-only (pass --open-signup to let anyone create an account).",
);
console.log(
  state.sfuSet
    ? "  Rooms: through the Cloudflare Realtime SFU (up to 20 people; encrypted in transit)."
    : "  Rooms: peer to peer, up to 4 people (add --sfu-app-id/--sfu-app-secret for bigger rooms).",
);
if (openSignup && !turnstileSet) {
  console.log("  Tip: add --turnstile-site-key/--turnstile-secret to protect sign-up from bots.");
}
if (setupToken) {
  console.log(`\n  Create your household (works once, until the first household exists):`);
  console.log(`\n    https://${domain}/#setup=${setupToken}\n`);
}
if (!turnNow && !previous.turnSet) {
  console.log(
    "  Calls between different networks need TURN: create a key in the Cloudflare dashboard\n" +
      "  (Realtime → TURN) and re-run with --turn-key-id <id> --turn-key-token <token>.",
  );
}
