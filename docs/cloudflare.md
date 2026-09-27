# Deploying OpenTinCan to your Cloudflare account

OpenTinCan runs entirely on your own Cloudflare account, and the free plan is enough for a
household. Nothing passes through this project's servers.

What gets created:

| Resource | Used for |
|---|---|
| Worker `opentincan` | API, companion app (`/`), device emulator (`/device/`) |
| Durable Object `HouseholdObject` (one per household) | live phones, companion sessions, calls; hibernates when idle |
| Durable Object `PairingObject` | phones waiting for a pairing code |
| D1 database `opentincan` | households, people, phones, allow-lists, quiet hours, voicemail index |
| R2 bucket `opentincan-voicemail` | voicemail audio |
| Workers AI (optional) | voicemail transcripts (Whisper, billed per audio minute) |
| Realtime TURN key (optional) | relays audio when phones can't connect directly |

> A one-command `opentincan deploy cloudflare` is planned (M5). Until then, deploy by hand:

```sh
npm install && npm run build
cd apps/server-cloudflare
npx wrangler login
npx wrangler d1 create opentincan         # paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create opentincan-voicemail
# Optional transcripts: uncomment the "ai" binding in wrangler.jsonc
npx wrangler secret put SETUP_TOKEN        # any long random string, e.g. openssl rand -hex 24
# Optional but recommended: create a TURN key in the dashboard (Realtime → TURN), then
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npm run deploy                             # applies D1 migrations and deploys
```

Then open `https://opentincan.<your-subdomain>.workers.dev/#setup=<SETUP_TOKEN>` to create your
household. The token only works until the first household exists.

## Local development

```sh
npm run build            # at the repo root
cd apps/server-cloudflare
npx wrangler dev --var SETUP_TOKEN:dev-token   # after: npx wrangler d1 migrations apply DB --local
```

Run the shared end-to-end scenario against it (fresh local state required):

```sh
OTC_E2E_URL=http://localhost:8787 OTC_E2E_SETUP_TOKEN=dev-token npx vitest run tests/e2e
```

## How it maps onto the shared server

The Worker, the Durable Objects, and the self-hosted Node server all run the same
`@opentincan/server-app` code. Sockets carry a routing hint (`/ws/device?device=…`,
`/ws/app?household=…`) so the Worker can pick the household's Durable Object. Each object
runs the shared `Gateway`/`HouseholdHub` over hibernatable WebSockets. Peer state lives in socket
attachments and live calls in object storage. Quiet-hours changes are scheduled with an alarm at
the exact next boundary, so an idle household costs nothing.
