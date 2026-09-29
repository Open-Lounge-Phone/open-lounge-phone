# Self-hosting Open Lounge Phone

Open Lounge Phone runs on any machine with Docker (a spare PC, NAS, Raspberry Pi 4/5, or a small VPS).
Nothing is sent to this project or any third party; calls go directly between your phone and your
companion app, relayed by your own TURN server only when a direct path is impossible.

## Quick start (Docker)

> The Docker packaging has not been build-tested yet; please report issues.

```sh
git clone <this repo> openloungephone && cd openloungephone
cp .env.example .env        # edit PUBLIC_URL, TURN_URLS, TURN_SECRET
docker compose up -d
docker compose logs openloungephone   # shows the one-time setup link
```

Open the setup link, create your household, then pair a phone: lift its handset, and it shows a
6-digit code on its status strip and reads it aloud; enter the code in the companion app.

## Without Docker

Requires Node 22+.

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
| `FEDERATION` | on | Connect with people on other Open Lounge Phone servers. `0` turns it off. Needs `PUBLIC_URL` to be the `https://` name other servers reach you at. The server key lives in `DATA_DIR/federation-key.jwk` (back it up; other servers pin it) |
| `FAIR_USE`, `FAIR_USE_*` | unset (unlimited) | A fair-use allowance for a public server: `FAIR_USE=hub` applies the hub's defaults; `FAIR_USE_CALL_MINUTES`, `_VOICEMAILS`, `_VOICEMAIL_MB`, `_KNOCKS`, `_PHONES_PER_SPACE`, `_SPACES_PER_ACCOUNT` set or override one (a number, or `unlimited`). See [hub.md](hub.md) |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | unset | Cloudflare Turnstile on sign-up (both needed) |
| `OPERATORS` | unset | Comma-separated handles who see the Operator view |
| `FUNDING_BALANCE_USD`, `SPONSOR_URL` | unset | Funding card and Sponsor button (public hubs; see [hub.md](hub.md)) |
| `TRUST_PROXY` | unset | `1` behind your own reverse proxy: take the client address from `X-Forwarded-For` for per-IP limits |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_API_URL` | unset | A LiveKit server as the rooms' media relay (see below); without one, rooms are peer to peer and hold 4 people |
| `SFU_APP_ID`, `SFU_APP_SECRET` | unset | Or a Cloudflare Realtime SFU app as the relay |

Passkeys are tied to the site's host name. If you reach the server through a reverse proxy or
several names, set `PUBLIC_URL` to the one address people use.

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
