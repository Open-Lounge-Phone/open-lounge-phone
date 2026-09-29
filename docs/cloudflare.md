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

## Deploy (one command)

```sh
npm install && npm run build
npx wrangler login                     # once
cd apps/server-cloudflare
npm run deploy:instance -- --instance home --domain phone.example.com
```

The script is idempotent. It creates the D1 database `openloungephone-<instance>` and the R2
bucket `openloungephone-<instance>-voicemail` if they're missing, applies migrations, and
deploys the Worker `openloungephone-<instance>` on your custom domain (the domain must be a
zone in the same Cloudflare account). On first run it sets a one-time `SETUP_TOKEN` and prints
your setup link. It also generates the instance's **federation key** once (secret
`FED_PRIVATE_KEY`; other servers pin its public half, so it's never regenerated) and sets
`PUBLIC_URL=https://<domain>`, the host in everyone's `name@host` address. Account-specific IDs
go to `apps/server-cloudflare/instances/` (gitignored).

Options:
- `--turn-key-id <id> --turn-key-token <token>`: TURN relay for calls across networks. Create
  a key in the dashboard under Realtime → TURN.
- `--no-ai`: skip Workers AI voicemail transcripts.
- `--new-setup-token`: issue a fresh setup link (only useful before the first household exists).
- `--open-signup`: let anyone create an account on the instance (sets the `OPEN_SIGNUP` var; a
  public hub). Every deploy sets it, so leaving the flag out makes the instance invite-only again.
  A public instance **requires TURN** (the script refuses without a TURN key, now or from an
  earlier run) and gets the hub's **fair-use allowance** (`FAIR_USE=hub`; `--fair-use none` for
  unlimited).
- `--turnstile-site-key <key> --turnstile-secret <secret>`: Cloudflare Turnstile on sign-up
  (dashboard → Turnstile → add a widget for the domain). Without keys there's no check.
- `--operator <handle[,handle]>`: who sees the Operator view (suspend or exempt accounts, block
  servers).
- `--funding-balance <usd>`: show the funding card (see [hub.md](hub.md));
  `--sponsor-url <https://…>`: show a Sponsor button (hidden while unset).

The public hub is deployed with (see [hub.md](hub.md)):

```sh
npm run deploy:instance -- --instance hub --domain hub.openloungephone.app --open-signup \
  --turn-key-id <id> --turn-key-token <token> \
  --turnstile-site-key <key> --turnstile-secret <secret> \
  --operator <your handle> --funding-balance 150
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

## How it maps onto the shared server

The Worker, the Durable Objects, and the self-hosted Node server all run the same
`@openloungephone/server-app` code. Sockets carry a routing hint (`/ws/device?device=…`,
`/ws/app?household=…`) so the Worker can pick the household's Durable Object. Each object
runs the shared `Gateway`/`HouseholdHub` over hibernatable WebSockets. Peer state lives in socket
attachments and live calls in object storage. Quiet-hours changes are scheduled with an alarm at
the exact next boundary, so an idle household costs nothing. Other servers reach the Worker at
`/.well-known/openloungephone` and the signed `/fed/v1/*` endpoints; `/fed/v1/stream` goes to the
`FederationObject` for the calling server (see [federation.md](federation.md)).
