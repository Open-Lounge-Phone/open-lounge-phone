# OpenTinCan

A free, open-source, screen-free phone. Big mechanical buttons, one per person, and nothing else:
no browser, no games, no strangers.

- **Kids' phone** — calls only the contacts a guardian approves, respects quiet hours (callers
  get voicemail with a transcript instead of waking anyone up), and reports its battery level.
- **Lounge phone** *(later)* — a shared booth phone you take over by scanning a QR code, which
  forgets you the moment you walk away.

<p align="center">
  <img src="docs/images/emulator-ringing.png" alt="The browser phone emulator ringing, with its developer panel" width="640">
</p>

OpenTinCan is "batteries included": deploy the backend to **your own free Cloudflare account**
or **self-host it with Docker** on hardware you control. Nobody — including this project — sits
in the middle of your calls.

## Status

Phase 1 (software, runs on ordinary computers) is in progress.

| Milestone | What | State |
|---|---|---|
| M0 | Monorepo, CI, licenses | done |
| M1 | Wire protocol + core logic (access control, quiet hours, call state machines) | done |
| M2 | Self-hosted server, browser phone emulator, companion app — first real call | done |
| M3 | Cloudflare backend (Workers, Durable Objects, D1, TURN) | done (local; see [docs/cloudflare.md](docs/cloudflare.md)) |
| M4 | Kids' features: invites, passkeys, voicemail + transcripts, richer device status | done |
| M5 | One-command deploy CLI, desktop app (Tauri) with USB keypads | next |

Later phases: Lounge variant → ESP32-S3 firmware on dev boards → custom PCB → wireless product.
See [docs/architecture.md](docs/architecture.md).

## Layout

```
packages/protocol   wire protocol (zod schemas) — the contract every device speaks
packages/core       pure domain logic shared by all backends and devices
packages/db         SQL migrations + typed store (Cloudflare D1 and SQLite)
packages/server-app backend-agnostic HTTP API, connection gateway, household call hub
packages/client     browser helpers: socket, WebRTC call media, tones
apps/server-selfhost Node server (+ Dockerfile, compose.yaml with coturn)
apps/device-web     browser emulator of the phone (keys, LEDs, status display, handset)
apps/companion      companion PWA for guardians and contacts
firmware/           ESP32-S3 firmware (later phase)
hardware/           KiCad PCB and enclosure (later phase)
docs/               architecture and the generated protocol reference
```

## Try it

```sh
npm install
npm start
```

Open the setup link the server prints, create your household, then open
`http://localhost:8787/device/` in another tab. That's an emulated phone. Press Space to lift its
handset and it reads out a pairing code; enter it in the companion app, then call each other.
See [docs/self-hosting.md](docs/self-hosting.md) for Docker and HTTPS.

## Development

Requires Node 22+.

```sh
npm install
npm test            # unit tests
npm run check       # lint + typecheck + tests (what CI runs)
npm run docs:protocol   # regenerate docs/protocol.md after changing packages/protocol
```

## License

Software: [AGPL-3.0-or-later](LICENSE). Hardware designs: [CERN-OHL-S-2.0](hardware/LICENSE).
If you run a modified OpenTinCan server for others, you must share your changes.
