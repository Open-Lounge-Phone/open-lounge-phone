# Deploying Open Lounge Phone to your Cloudflare account

Open Lounge Phone runs entirely on your own Cloudflare account, and the free plan is enough for a
household. Nothing passes through this project's servers.

What gets created:

| Resource | Used for |
|---|---|
| Worker `openloungephone-<instance>` | API, companion app (`/`), device emulator (`/device/`) |
| Durable Object `HouseholdObject` (one per household) | live phones, companion sessions, calls; hibernates when idle |
| Durable Object `PairingObject` | phones waiting for a pairing code |
| Durable Object `FederationObject` (one per other server) | the stream for calls with that server; hibernates, and the side that opened it closes it after a minute idle |
| D1 database `openloungephone-<instance>` | accounts, spaces, phones, allow-lists, connections, quiet hours, voicemail index, call log |
| R2 bucket `openloungephone-<instance>-voicemail` | voicemail audio |
| Workers AI (optional) | voicemail transcripts (Whisper, billed per audio minute) |
| Realtime TURN key (optional) | relays audio when phones can't connect directly |
| Realtime SFU app (optional) | rooms of more than 4 people (party lines, phone rooms, 3-way calls); without it rooms are peer to peer |

## Deploy (one command)

```sh
npm install && npm run build
npx wrangler login                     # once
npx openloungephone deploy cloudflare  # asks for the rest
```

The CLI (`apps/cli`, run from this repository) asks for the instance name, the domain and
whether sign-up is open, then for the optional keys — a Realtime **TURN** key (calls across
networks; required for open sign-up), an **SFU** app (rooms of more than 4) and **Turnstile**
(open sign-up) — **without echoing them**. Keys already in the environment are used without
asking (`TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `SFU_APP_ID`, `SFU_APP_SECRET`,
`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`); secrets are never taken as command-line flags. Before
changing anything it runs a preflight — the web apps are built, wrangler is logged in, which
account (set `CLOUDFLARE_ACCOUNT_ID` if you have several), and that every resource it will
touch is named `openloungephone-<instance>…` — and shows a summary to confirm. Afterwards it
checks the new deployment (`openloungephone status`). Non-interactive:

```sh
TURN_KEY_ID=… TURN_KEY_API_TOKEN=… npx openloungephone deploy cloudflare \
  --instance home --domain phone.example.com --yes      # --dry-run: preflight and summary only
```

`npx openloungephone help deploy` lists every option. `npx openloungephone doctor` checks
Node, the build, wrangler and your login; `npx openloungephone status https://<domain>` checks
a running instance (health, versions, federation key).

Under the hood the CLI runs `scripts/deploy.ts`, which you can also run directly
(`npm run deploy:instance -- --instance home --domain phone.example.com` in
`apps/server-cloudflare`; it reads the same environment variables).

Options (of `scripts/deploy.ts`; the CLI takes the same ones, except that the TURN, SFU and
Turnstile keys come only from the environment or its prompts):
- `--turn-key-id <id> --turn-key-token <token>`: TURN relay for calls across networks. Create
  a key in the dashboard under Realtime → TURN.
- `--sfu-app-id <id> --sfu-app-secret <secret>`: the rooms' media relay (dashboard → Realtime →
  SFU → create an app), stored as the `SFU_APP_ID` / `SFU_APP_SECRET` secrets. When the flags are
  left out the script reads them from `instances/sfu.env` (`SFU_APP_ID=…`, `SFU_APP_SECRET=…`;
  gitignored) if it exists. Relayed rooms are encrypted in transit, not end to end (see
  [security-model.md](security-model.md)).
- `--no-ai`: skip Workers AI voicemail transcripts.
- `--new-setup-token`: issue a fresh setup link (only useful before the first household exists).
- `--open-signup`: let anyone create an account on the instance (sets the `OPEN_SIGNUP` var; a
  public hub). Every deploy sets it, so leaving the flag out makes the instance invite-only again.
  A public instance **requires TURN** (the script refuses without a TURN key, now or from an
  earlier run) and gets the hub's **fair-use allowance** (`FAIR_USE=hub`; `--fair-use none` for
  unlimited).
- `--turnstile-site-key <key> --turnstile-secret <secret>`: Cloudflare Turnstile on sign-up
  (dashboard → Turnstile → add a widget for the domain). Without keys there's no check.
- `--refuse-recorded-calls`: other servers' recorded calls don't reach your people (sets the
  `REFUSE_RECORDED_CALLS` var on every deploy; see [security-model.md](security-model.md)).
- `--operator <handle[,handle]>`: who sees the Operator view (suspend or exempt accounts, block
  servers).
- `--funding-balance <usd>`: show the funding card (see [hub.md](hub.md));
  `--sponsor-url <https://…>`: show a Sponsor button (hidden while unset).

The public hub is deployed with (see [hub.md](hub.md)):

```sh
npx openloungephone deploy cloudflare --instance hub --domain hub.openloungephone.app \
  --open-signup --operator <your handle> --funding-balance 150   # asks for TURN and Turnstile
```

Re-run the same command after pulling updates to migrate and redeploy.

## Local development

```sh
npm run build            # at the repo root
cd apps/server-cloudflare
npx wrangler dev --var SETUP_TOKEN:dev-token   # after: npx wrangler d1 migrations apply DB --local
```

Run the shared end-to-end scenario against it (fresh local state required):

```sh
OLP_E2E_URL=http://localhost:8787 OLP_E2E_SETUP_TOKEN=dev-token npx vitest run tests/e2e
```

Two local instances federating with each other (the interop scenario on Workers: knock, accept,
cross-server call, voicemail, block, and the server-pair stream closing after a minute idle; CI
runs it on every push in the `Interop` workflow, with no Cloudflare account):

```sh
npm run build
OLP_E2E_CLOUDFLARE=1 npx vitest run tests/e2e/cloudflare.test.ts   # about 90 s
```

Rooms through the real SFU (three headless Chromium companions in one room with audio both
ways, one leaving and rejoining, then a 1:1 call merged into a 3-way call) — put the SFU app's
`SFU_APP_ID` and `SFU_APP_SECRET` in `apps/server-cloudflare/.dev.vars` (gitignored) first:

```sh
npm run build && npm run assets -w apps/server-cloudflare
OLP_SFU_CHECK=1 PLAYWRIGHT_CORE=/path/to/playwright-core npx vitest run tests/e2e/live/rooms.test.ts
```

It starts two `wrangler dev` instances (local D1, R2 and Durable Objects, no AI) as
`a.localhost` and `b.localhost` with `DEV_LOOPBACK=1`, a development-only switch that sends
`*.localhost` requests to 127.0.0.1.

## How it maps onto the shared server

The Worker, the Durable Objects, and the self-hosted Node server all run the same
`@openloungephone/server-app` code. Sockets carry a routing hint (`/ws/device?device=…`,
`/ws/app?household=…`) so the Worker can pick the household's Durable Object. Each object
runs the shared `Gateway`/`HouseholdHub` over hibernatable WebSockets. Peer state lives in socket
attachments and live calls in object storage. Quiet-hours changes are scheduled with an alarm at
the exact next boundary, so an idle household costs nothing. Other servers reach the Worker at
`/.well-known/openloungephone` and the signed `/fed/v1/*` endpoints; `/fed/v1/stream` goes to the
`FederationObject` for the calling server (see [federation.md](federation.md)).
