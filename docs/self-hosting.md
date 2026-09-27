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

Passkeys are tied to the site's host name. If you reach the server through a reverse proxy or
several names, set `PUBLIC_URL` to the one address people use.

## HTTPS

Browsers only grant microphone access to secure pages (`https://`, or `http://localhost`). To use
the companion app from phones, put the server behind HTTPS, for example with
[Caddy](https://caddyserver.com) (`reverse_proxy localhost:8787`) or a Cloudflare Tunnel.
WebSockets (`/ws/*`) must be proxied too.

## Emulated phones

Until hardware exists, open `/device/` in a browser to get an emulated phone. Add
`?profile=kitchen` to run several phones in one browser.

## Backups

Everything lives in `DATA_DIR`: the database `openloungephone.sqlite` and voicemail audio under
`blobs/` (the `openloungephone-data` volume with Docker).
