# Deploying Open Lounge Phone to your Cloudflare account

Open Lounge Phone runs entirely on your own Cloudflare account, and the free plan is enough for a
household. Nothing passes through this project's servers.

What gets created:

| Resource | Used for |
|---|---|
| Worker `openloungephone-<instance>` | API, companion app (`/`), device emulator (`/device/`) |
| Durable Object `HouseholdObject` (one per household) | live phones, companion sessions, calls; hibernates when idle |
| Durable Object `PairingObject` | phones waiting for a pairing code |
| D1 database `openloungephone-<instance>` | households, people, phones, allow-lists, quiet hours, voicemail index |
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
your setup link. Account-specific IDs go to `apps/server-cloudflare/instances/` (gitignored).

Options:
- `--turn-key-id <id> --turn-key-token <token>`: TURN relay for calls across networks. Create
  a key in the dashboard under Realtime → TURN.
- `--no-ai`: skip Workers AI voicemail transcripts.
- `--new-setup-token`: issue a fresh setup link (only useful before the first household exists).
- `--open-signup`: let anyone create an account on the instance (sets the `OPEN_SIGNUP` var; a public hub). Every deploy sets it, so leaving the flag out makes the instance invite-only again.

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
the exact next boundary, so an idle household costs nothing.
