# OpenTinCan — notes for agents

Open-source, screen-free intercom phone. Software phase first (runs on computers), then ESP32-S3
firmware, then a custom PCB in a Trimline-style corded phone powered by USB-C. Read
`README.md` (status table), `docs/architecture.md`, and `docs/protocol.md` before changing code.
Hardware design lives in `hardware/DESIGN.md`.

## Decisions already made (don't relitigate without the owner)
- **Variants:** Kids' phone first; Lounge phone (QR takeover, presence, ephemeral sessions) later.
- **Backend is pluggable:** the user's own Cloudflare account (Workers, Durable Objects, D1, R2,
  Realtime SFU, Workers AI Whisper) **or** self-hosted (Node + SQLite + coturn in Docker). No
  hosted dependency may become mandatory. Same Hono app + Drizzle schema for both.
- **Clients:** browser device emulator first (`apps/device-web`), Tauri desktop wrapper later.
  Companion app is a PWA (`apps/companion`).
- **Licenses:** AGPL-3.0-or-later for software, CERN-OHL-S-2.0 for `hardware/`.
- **Guardian auth:** passkeys (WebAuthn) — no email service required.
- **Device auth:** Ed25519 keypair generated on the device; pairing via 6-digit code shown on
  the device; each connection answers a signed `auth.challenge`.
- **Voicemail:** recorded by the *caller's* client (MediaRecorder/Opus), uploaded, transcribed.

## Conventions
- npm workspaces (pnpm is not installed on the owner's machine). Node ≥ 22.
- TypeScript 7, `moduleResolution: Bundler`, and **relative imports use the `.ts` extension**
  (`import { x } from "./x.ts"`) so Node can run sources directly via type stripping. Workspace
  packages export `src/index.ts` directly — there is no build step for libraries.
- Biome for lint + format (`npm run lint`, `npx biome check --write .`). 2-space, 100 cols.
- Vitest; tests live next to sources as `*.test.ts`. Verify tests fail when the code is broken.
- `npm run check` = lint + typecheck (`tsc -b`) + tests. CI runs it plus a protocol-docs drift check.
- `packages/core` stays pure (no I/O, no clock reads — pass `now` in). Backends adapt only
  storage, sockets, media, blobs, transcription.
- Access control is default-deny; every path that can ring a device goes through
  `authorizeInbound` / `authorizeOutbound`.

## Protocol
- Source of truth: `packages/protocol/src/messages.ts` (zod). After any change run
  `npm run docs:protocol` and commit `docs/protocol.md`.
- Additive optional fields keep `PROTOCOL_VERSION`; anything else bumps it.
- Messages are flat JSON `{ t: "type", id?, ... }`, ≤ 16 KiB (firmware buffer budget).
- The handset state machine `deviceStep` in `packages/core/src/device.ts` is what the emulator
  runs and what firmware must mirror.

## Progress log
Keep this section current when finishing a milestone.
- **M0 scaffold** — done.
- **M1 protocol + core** — done (protocol codec, quiet hours with DST/midnight handling,
  default-deny access, call-room and device state machines).
- **M2 first call (self-host)** — in progress. See "M2 notes" below.
- M3 Cloudflare backend, M4 Kids' features, M5 CLI + Tauri — not started.
