# OpenTinCan

A free, open-source, screen-free phone. Big mechanical buttons, one per person, and nothing else:
no browser, no games, no strangers.

- **Kids' phone** — calls only the contacts a guardian approves, respects quiet hours (callers
  get voicemail with a transcript instead of waking anyone up), and reports its battery level.
- **Lounge phone** *(later)* — a shared booth phone you take over by scanning a QR code, which
  forgets you the moment you walk away.

OpenTinCan is "batteries included": deploy the backend to **your own free Cloudflare account**
or **self-host it with Docker** on hardware you control. Nobody — including this project — sits
in the middle of your calls.

## Status

Phase 1 (software, runs on ordinary computers) is in progress.

| Milestone | What | State |
|---|---|---|
| M0 | Monorepo, CI, licenses | done |
| M1 | Wire protocol + core logic (access control, quiet hours, call state machines) | done |
| M2 | Self-hosted server, browser phone emulator, companion app — first real call | next |
| M3 | Cloudflare backend (Workers, Durable Objects, D1, R2, Realtime SFU) | |
| M4 | Kids' features: button mapping, allow-list, quiet hours, voicemail, device status | |
| M5 | One-command deploy CLI, desktop app (Tauri) with USB keypads | |

Later phases: Lounge variant → ESP32-S3 firmware on dev boards → custom PCB → wireless product.
See [docs/architecture.md](docs/architecture.md).

## Layout

```
packages/protocol   wire protocol (zod schemas) — the contract every device speaks
packages/core       pure domain logic shared by all backends and devices
apps/               servers, device emulator, companion app (coming in M2+)
firmware/           ESP32-S3 firmware (later phase)
hardware/           KiCad PCB and enclosure (later phase)
docs/               architecture and the generated protocol reference
```

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
