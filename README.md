# Open Lounge Phone

A free, open-source, screen-free phone. Real mechanical keys, a handset, and nothing else: no
browser, no games, no strangers.

- **Kids' phone** — calls only the contacts a guardian approves, respects quiet hours (callers
  get voicemail with a transcript instead of waking anyone up), and reports its battery level.
- **Voicemail everywhere** — any call that isn't answered (no answer, declined, busy, quiet
  hours, unavailable) goes to a greeting — the standard one, your recorded name, or your own —
  and the message lands in the callee's inbox, across servers too.
- **Lounge phone** — a shared phone anyone in the space takes over as themselves by scanning its
  code and pressing the key it flashes; it forgets them the moment they're done. People from
  other servers can use it too, if the space allows guests.
- **Grown-ups** use the companion app on their own phone or computer, or any old device as a
  phone (`/device/`, add it to the home screen).

<p align="center">
  <img src="docs/images/emulator-ringing.png" alt="The browser phone emulator ringing, with its developer panel" width="640">
</p>

Run it on **your own Cloudflare account** or **self-host it with Docker**, or join the free
public hub at [hub.openloungephone.app](https://hub.openloungephone.app). Servers connect to each other, so everyone can reach everyone: you
knock on someone's address (`name@server`), and once they accept you can call. Nobody —
including this project — sits in the middle of your calls, and there is no bridge to the phone
network, ever.

## Status

The software works end to end today; the hardware is being designed in the open.

| Phase | What | State |
|---|---|---|
| M0–M4 | Protocol and core logic; self-hosted server, browser phone, companion app; Cloudflare backend; invites, passkeys, voicemail with transcripts | done |
| Lounge | QR takeover with a key-press proof, ephemeral sessions, "open to chat" | done (software) |
| P1 / P1b | Accounts and handles (`name@server`), several households per account, open sign-up; spaces (home, team, organization); handles reserved 90 days | done |
| P2 | Connections ("buddies"): knock, accept, decline, block — on one server and across servers (signed server-to-server requests) | done |
| P3 | Calls across servers, voicemail, opt-in presence, Lounge guests from other servers | done |
| P4 | The public hub: free, donation-funded, fair-use allowance, Turnstile, operator view, export and account deletion | **live** at hub.openloungephone.app (2026-09-29) |
| Voicemail everywhere | Unanswered calls go to voicemail for every caller and callee (people, kids' phones, Lounge guests, other servers); greetings (standard, recorded name, custom); ring time; recording the greeting on the phone | done (software) |
| M5 | One-command deploy CLI and desktop app | deploy script done; the rest not started |
| P2b, P3.5, P5, P6 | Per-buddy call timeline; rooms (party lines, 3-way calls); interop tests in CI and a versioned federation spec; professional features (directory, hunt groups, business hours) | planned |
| Firmware | ESP32-S3 firmware, starting on dev boards | not started |
| Hardware | One board (ESP32-S3, 12 hot-swap keys, e-ink strip, NFC, USB-C handset port) in a 3D-printable base | schematic done; board placed, routing next; enclosure in progress |

More: [architecture](docs/architecture.md), [federation](docs/federation.md),
[the public hub](docs/hub.md), [privacy](docs/privacy.md), [hardware](hardware/README.md).

## Layout

```
packages/protocol    wire protocol (zod schemas) — the contract every device speaks
packages/core        pure domain logic shared by all backends and devices
packages/db          SQL migrations + typed store (Cloudflare D1 and SQLite)
packages/federation  server-to-server signatures (RFC 9421, Ed25519), keys, /fed/v1 schemas
packages/server-app  backend-agnostic HTTP API, connection gateway, household hubs, federation
packages/client      browser helpers: socket, WebRTC call media, tones
apps/server-selfhost Node server (+ Dockerfile, compose.yaml with coturn)
apps/server-cloudflare Worker + Durable Objects + D1 + R2, and the deploy script
apps/device-web      the phone in a browser (keys, LEDs, status strip, handset)
apps/companion       companion PWA for guardians, grown-ups and operators
apps/site            the project website (openloungephone.app)
firmware/            ESP32-S3 firmware (later)
hardware/            schematic, board layout and enclosure, all as code
docs/                architecture, federation, hub, privacy, generated protocol reference
```

## Try it

```sh
npm install
npm start
```

Open the setup link the server prints, create your household, then open
`http://localhost:8787/device/` in another tab. That's the phone. Press Space to lift its
handset and it reads out a pairing code; enter it in the companion app, then call each other.
See [docs/self-hosting.md](docs/self-hosting.md) for Docker and HTTPS (the Docker packaging has
not been build-tested yet), and [docs/cloudflare.md](docs/cloudflare.md) to run it on your own
Cloudflare account.

## Development

Requires Node 22+.

```sh
npm install
npm test            # unit tests (including a two-server federation test)
npm run check       # lint + typecheck + tests (what CI runs)
npm run docs:protocol   # regenerate docs/protocol.md after changing packages/protocol
```

## License

Software: [AGPL-3.0-or-later](LICENSE). Hardware designs: [CERN-OHL-S-2.0](hardware/LICENSE).
If you run a modified Open Lounge Phone server for others, you must share your changes.

Proudly supported by [unsubscribe.llc](https://www.unsubscribe.llc/).
