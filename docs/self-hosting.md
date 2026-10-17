# Self-hosting Open Lounge Phone

Open Lounge Phone runs on any machine with Docker (a spare PC, NAS, Raspberry Pi 4/5, or a small VPS).
Nothing is sent to this project or any third party; calls go directly between your phone and your
companion app, relayed by your own TURN server only when a direct path is impossible.

## Quick start (Docker)

> The Docker packaging has not been build-tested yet; please report issues.

```sh
git clone https://github.com/Open-Lounge-Phone/open-lounge-phone.git openloungephone
cd openloungephone && npm install
npx openloungephone doctor          # Node, Docker, Docker Compose
npx openloungephone selfhost init   # asks a few questions, writes compose.yaml and .env
docker compose up -d
docker compose logs openloungephone # shows the one-time setup link
```

`selfhost init` asks for the public URL and whether to bundle a **TURN relay** (coturn, for
calls across networks) and **LiveKit** (rooms of more than 4); both are compose profiles that
`.env`'s `COMPOSE_PROFILES` turns on. It writes `.env` with fresh random secrets (`TURN_SECRET`,
`LIVEKIT_API_SECRET`; mode 600) and never overwrites existing files without `--force`.
Non-interactive: `npx openloungephone selfhost init --public-url phone.example.com --coturn
--yes` (`--dir <path>` writes elsewhere; outside this checkout the image is built from the git
repository). `npx openloungephone help selfhost` lists every option. Prefer to do it by hand?
Copy `.env.example` to `.env`, edit it, and use the repository's `compose.yaml`.

Open the setup link, create your household, then pair a phone: lift its handset, and it shows a
6-digit code on its status strip and reads it aloud; enter the code in the companion app.
Check the server from anywhere with `npx openloungephone status https://phone.example.com`
(health, versions, federation key).

## Without Docker

Requires Node 22.18+.

```sh
npm install
npm start          # builds the web apps and starts the server on :8787
```

Configuration is by environment variable:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `PUBLIC_URL` | `http://localhost:$PORT` | Base URL printed in the setup link |
| `DATA_DIR` | `./data` | SQLite database location |
| `STUN_URLS` | `stun:stun.cloudflare.com:3478` | Comma-separated; empty disables STUN |
| `TURN_URLS`, `TURN_SECRET` | unset | TURN relay with time-limited credentials (coturn `use-auth-secret`) |
| `TRANSCRIBE_URL` | unset | OpenAI-compatible `/v1/audio/transcriptions` endpoint for voicemail transcripts |
| `TRANSCRIBE_MODEL`, `TRANSCRIBE_API_KEY` | `whisper-1`, unset | Passed to that endpoint |
| `OPEN_SIGNUP` | unset (off) | `1` lets anyone create an account (a passkey, a handle and their own household). Off: people join only through invites; the first-run setup link still creates the first household |
| `FEDERATION` | on | Connect with people on other Open Lounge Phone servers. `0` turns it off. Needs `PUBLIC_URL` to be the `https://` name other servers reach you at (a server on a `localhost` URL only federates with other `localhost` servers; a public one never contacts loopback, IP-literal or local-network names). The server key lives in `DATA_DIR/federation-key.jwk` (back it up; other servers pin it) |
| `FAIR_USE`, `FAIR_USE_*` | unset (unlimited) | A fair-use allowance for a public server: `FAIR_USE=hub` applies the hub's defaults; `FAIR_USE_CALL_MINUTES`, `_VOICEMAILS`, `_VOICEMAIL_MB`, `_KNOCKS`, `_PHONES_PER_SPACE`, `_SPACES_PER_ACCOUNT` set or override one (a number, or `unlimited`). See [hub.md](hub.md) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | unset | Cloudflare Turnstile on sign-up (both needed) |
| `OPERATORS` | unset | Comma-separated **account ids** (`acc_…`) who see the Operator view. Handles give no rights (a handle can change hands); if you put one here, the server logs the account id to use instead |
| `FUNDING_BALANCE_USD`, `SPONSOR_URL` | unset | Funding card and Sponsor button (public hubs; see [hub.md](hub.md)) |
| `TRUST_PROXY` | unset | `1` behind your own reverse proxy: take the client address from `X-Forwarded-For` for per-IP limits |
| `ADDONS` | unset (off) | `on` lets people link add-ons to their accounts: services such as an AI companion, at `you+name@host`, reachable only by their owner, and parts of them (shares, `you+name+share@host`) by the people the owner gives them to ([add-ons.md](add-ons.md)). Off: nobody can link one, linked ones can't connect or be called, and the server doesn't advertise the `addons` and `addon-shares` features to other servers |
| `REFUSE_RECORDED_CALLS` | unset | `1`: calls from other servers that are recorded (their space turned recording on) don't reach your people — refused when placed, or ended when the recording is announced (see [security-model.md](security-model.md)) |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_API_URL` | unset | A LiveKit server as the rooms' media relay (see below); without one, rooms are peer to peer and hold 4 people |
| `SFU_APP_ID`, `SFU_APP_SECRET` | unset | Or a Cloudflare Realtime SFU app as the relay |

**No internet?** The server works on a network of its own: set `STUN_URLS=` (empty), give it a
local name and an HTTPS front with your own certificate authority, and point hardware phones at
`ws://<its address>:8787`. See the user guide's *Run it offline* (`docs/site/how-to/run-it-offline.md`);
`tests/e2e/live/offline.test.ts` (`OLP_OFFLINE_E2E=1`) checks it.

Passkeys are tied to the site's host name. If you reach the server through a reverse proxy or
several names, set `PUBLIC_URL` to the one address people use.

**Moving from `localhost` (or any address) to a real domain:** passkeys made at the old address
don't work at the new one, so everyone will have to get back in another way. Before you move,
make sure each person has a **recovery code** (Account → Recovery code; the app reminds anyone
without one). After the move they choose "Lost your passkey?", enter their handle and code, and
make a new passkey at the new address. Someone whose only household is yours can also be sent a
sign-in link instead. Sessions already signed in keep working until they end (the app keeps no
passkey of them, so they end 90 days after their last use at most).

**Operators.** To find your account id for `OPERATORS`, start the server with
`OPERATORS=<your handle>` once: it gives no rights, and the log says
`Use the account id instead: OPERATORS=acc_…`.

## Rooms

Party lines, phone rooms (`standup@your.host`) and 3-way calls work out of the box as a
**peer-to-peer mesh** of up to 4 people, end-to-end encrypted like calls. For bigger rooms, run
the bundled [LiveKit](https://livekit.io) server and point Open Lounge Phone at it:

```sh
# in .env: LIVEKIT_URL=wss://livekit.your.host  LIVEKIT_API_URL=http://host.docker.internal:7880
#          LIVEKIT_API_KEY=openloungephone       LIVEKIT_API_SECRET=<32+ random characters>
docker compose --profile livekit up -d
```

`LIVEKIT_URL` is what browsers connect to (put it behind your HTTPS proxy, WebSockets
included); `LIVEKIT_API_URL` is how the server reaches LiveKit. LiveKit uses host networking for
its UDP media ports. Relayed rooms are encrypted in transit but not end to end (the relay could
hear them); end-to-end room encryption (SFrame) is planned. The LiveKit setup has been built
against its token and room APIs but not yet run end to end here; please report issues.

## HTTPS

Browsers only grant microphone access to secure pages (`https://`, or `http://localhost`). To use
the companion app from phones, put the server behind HTTPS, for example with
[Caddy](https://caddyserver.com) (`reverse_proxy localhost:8787`) or a Cloudflare Tunnel.
WebSockets (`/ws/*`) must be proxied too.

## Emulated phones

Until hardware exists, open `/device/` in a browser to get an emulated phone. Add
`?profile=kitchen` to run several phones in one browser.

## Backups

Everything lives in `DATA_DIR`: the database `openloungephone.sqlite`, voicemail audio under
`blobs/`, and the federation key `federation-key.jwk` (the `openloungephone-data` volume with
Docker). Keep the key: if it changes, other servers refuse yours until their operators re-trust it.
To replace it on purpose, rotate it (Operator view → **Rotate key**, or
`OLP_SESSION_TOKEN=… npx openloungephone federation rotate-key --url <your server>`): other
servers follow by themselves for 7 days, while `federation-key.previous.json` holds the signed
hand-over (see [federation.md](federation.md#key-rotation-implemented)). Back up both files
together.
