# OpenTinCan — notes for agents

Open-source, screen-free intercom phone. Software phase first (runs on computers), then ESP32-S3
firmware, then a custom PCB in a Trimline-style corded phone powered by USB-C. Read
`README.md` (status table), `docs/architecture.md`, and `docs/protocol.md` before changing code.
Hardware design lives in `hardware/DESIGN.md` (proposal r0.1: ESP32-S3-WROOM-1-N16R8,
ES8311+ES7210+NS4150B audio with hardware AEC reference, passive RJ9 handset, 10 MX hot-swap
keys with SK6812MINI-E LEDs, 2.9" e-ink strip between key rows, DRV5032 hall hook, USB-C →
BQ24074, LD2410C radar on Lounge, ST25DV NFC; its §13 lists protocol recommendations such as
key-algorithm negotiation ed25519|p256, per-key LED/strip messages, audio prompt ids). Its open
questions are the owner's to answer — don't decide them silently.
The main and deck boards are captured as **schematic-as-code in SKiDL** (`hardware/schematic/`,
`make build` in `hardware/`, venv in `hardware/.venv`, see `hardware/SCHEMATIC.md`): 3 variants
(kids, lounge, kids-batt) × 2 boards, ERC + custom checks (pin table, I2C addresses, FFC pinout,
LCSC/footprint validity). Open questions are parameters in `config.py`.
**Display & cost (owner decisions 2026-09-27):** Kids ships as **Lite** by default — no display;
printed relegendable keycap labels (companion: Manage phone → "Print key labels"), LEDs + voice.
**E-ink 2.9" (GDEY029T94) is the standard option** (Kids Standard, Lounge); cheaper displays
(0.91" SSD1306 OLED @0x3C, HT16K33 14-seg @0x70) plug into an optional Qwiic/STEMMA-QT I2C port on
the deck. `hello.display` = eink | seg14 | oled | none. Cost goal (revised): **$28–40 per phone is
fine**; it must be **affordable to build one-off** (a hobbyist's minimum JLCPCB order) and
**cheap at scale**. The hardware build reports both per variant; prefer JLC "basic" parts where
function allows (extended parts add setup fees that dominate small orders).
**Hardware rules:** `hardware/GUIDELINES.md` (child-safe/rugged/KISS: ESD at every
user-reachable conductor, no user-facing line straight to an ESP32 pin, solid GND plane (no split
grounds), S3 straps are GPIO0/3/45/46, captive keycaps, drop-in e-ink via ZIF, net-class widths,
review gates). PCB skills: run `hardware/tools/install-skills.sh` (kicad, emc, pcb-layout-review,
specs-to-pcb reference; pinned, MIT) — read them before layout work. KiCad 10 via
`brew install --cask kicad` (needs the owner's sudo password once).
**Power (owner decision 2026-09-27):** the Lounge phone requires a USB-C source advertising
≥1.5 A (ship a 5 V/3 A adapter); on a Default/USB-A source it runs in *reduced mode* (radar off,
LEDs ≤10 %, ringer ≤0.5 W, charging off) and reports `status.power {source, reduced}`; the strip
shows `USE 1.5A CHARGER` and the companion warns. Kids works on any source. Enforced by
`hardware/schematic/power_budget.yaml` + `check_power_budget`; policy in DESIGN.md §9.2a. Layout (KiCad) and 5
custom footprints are not done yet.

## Decisions already made (don't relitigate without the owner)
- **Variants:** Kids' phone first; Lounge phone (QR takeover, presence, ephemeral sessions) later.
- **No main screen; small e-ink status stripe only (owner decisions, 2026-09-27).** The phone is
  keys, LEDs, a narrow e-ink status strip, mic, speaker(s) and radios/sensors (Wi-Fi, BLE, NFC,
  mmWave, hall hook sensor, light sensor). The handset is bare/passive (earpiece + mic + magnet);
  all electronics live on the base PCB. Keys are standard MX-style mechanical keyboard switches in
  hot-swap sockets with keycaps, with per-key LEDs. Consequences:
  - **Open question:** which status display — e-ink strip, a fast-updating array of small
    segment displays (14/16-segment alphanumeric LED), or a tiny 0.91" 128x32 SSD1306 OLED
    (I2C; possibly one per key as a dynamic legend). `hardware/DESIGN.md` compares them. Until decided, device
    status is modelled as short text lines (≤ 16 chars each) that render on either; the emulator
    supports `?display=eink|segments`.
  - The status display shows short text more specifically than LEDs can: pairing code, offline,
    quiet hours, "Calling Mom…", failed-call reasons, battery, missed calls, lounge presence.
  - Pairing: the code is shown on the strip **and** announced audibly through the handset
    (pre-recorded digit prompts on hardware; speech synthesis in the emulator) when an unpaired
    handset is lifted; key LEDs pulse. BLE/NFC provisioning to be added for hardware (also needed
    for Wi-Fi onboarding).
  - Lounge QR takeover: a printed QR/NFC tag on the base plus a proximity proof (press the
    flashing key, NFC tap, mmWave presence) so a photographed tag can't be used remotely; the
    strip may render a QR if the chosen panel allows (see hardware/DESIGN.md). "Open to chat"
    presence on key LEDs and/or the strip.
  - Protocol follow-ups (M4): per-key LED state and strip text/status from server, audio prompt
    ids. Devices send `display: "eink"` (= the status strip).
- The emulator (`apps/device-web`) must look/behave like this hardware: keycapped keys with LEDs
  and an e-ink status strip on a base, plus a handset. Developer-only info goes in a clearly
  separate "developer panel", not on the simulated device.
- **Backend is pluggable:** the user's own Cloudflare account (Workers, Durable Objects, D1, R2,
  Realtime SFU, Workers AI Whisper) **or** self-hosted (Node + SQLite + coturn in Docker). No
  hosted dependency may become mandatory. Same Hono app + SQL migrations for both.
- **Clients:** browser device emulator first (`apps/device-web`), Tauri desktop wrapper later.
  Companion app is a PWA (`apps/companion`).
- **Licenses:** AGPL-3.0-or-later for software, CERN-OHL-S-2.0 for `hardware/`.
- **Guardian auth (target):** passkeys (WebAuthn) — no email service required.
- **Device auth:** Ed25519 keypair generated on the device; pairing via a 6-digit code the
  device announces; each connection answers a signed `auth.challenge`.
- **Voicemail:** recorded by the *caller's* client (MediaRecorder/Opus), uploaded, transcribed.
- **Storage:** plain SQL migrations in `packages/db/migrations` shared by D1 and `node:sqlite`
  (no Drizzle, no native modules). Self-host tracks applied migrations in the same
  `d1_migrations` table wrangler uses.
- **Guardian auth (interim):** first run prints a one-time setup link (`/#setup=<token>`) that
  creates the household + first guardian and returns a bearer session token. Passkeys come in M4.

## Conventions
- npm workspaces (pnpm is not installed on the owner's machine). Node ≥ 22.
- TypeScript 7, `moduleResolution: Bundler`, and **relative imports use the `.ts` extension**
  (`import { x } from "./x.ts"`) so Node can run sources directly via type stripping. Workspace
  packages export `src/index.ts` directly — there is no build step for libraries.
  `erasableSyntaxOnly` is on: no parameter properties, enums, or namespaces.
- Shared packages use only web-standard APIs (WebCrypto, fetch, WebSocket) so they run on Node,
  Workers and browsers. `tsconfig.base.json` includes the DOM lib for those types; Node-only code
  goes in `*/node.ts` entry points or `apps/server-selfhost`.
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
- **M2 first call (self-host)** — done. `packages/db`, `packages/server-app`, `packages/client`,
  `apps/server-selfhost`, `apps/device-web` (emulator), `apps/companion` (PWA). Verified in a real
  browser (Playwright): setup link → pair via code → phone calls guardian and guardian calls
  phone, WebRTC peer connection reaches `connected`, hangup from either side.
  Docker packaging (`apps/server-selfhost/Dockerfile`, `compose.yaml` with coturn) is written but
  **not yet built/tested** (Docker daemon was not running).
- Known gaps / next candidates: automated browser e2e (Playwright test with fake media) in CI;
  invites for non-guardian contacts (today contacts must be created via the store); passkeys;
  voicemail recording + transcription; strip text for "quiet until HH:MM" needs the end time in
  `config`; per-key LED/strip state pushed from the server.
- **M3 Cloudflare backend** — done locally, **not yet deployed to a real account** (needs the
  owner's Cloudflare login). `apps/server-cloudflare`: Worker (Hono) + `HouseholdObject` (one DO
  per household, hibernatable WebSockets, alarm for quiet-hours changes, rooms in DO storage) +
  `PairingObject` + D1 (same migrations) + static assets. The shared `tests/e2e/scenario.ts`
  passes against `wrangler dev`; browser check reached WebRTC `connected` via the Worker.
- **Media decision (provisional, 2026-09-27):** calls are 1:1 peer-to-peer WebRTC with
  Cloudflare Realtime **TURN** credentials (or coturn when self-hosting). The Realtime **SFU** is
  deferred until a feature needs it (group calls, server-side recording, or an ESP32 media path
  that's simpler against an SFU). The original plan said SFU; tell the owner if this matters.
- **M4 Kids' features** — server done (`f7414c8`): invites/sign-in links, passkeys
  (SimpleWebAuthn), voicemail upload + background transcription + `voicemail.new` + phone
  `config.missed`, `config.quietUntil`, P-256 device keys, removing people. UIs done
  (`a8d9876` emulator, `fccc5f1` companion). Browser-verified: passkeys via Chromium virtual
  authenticator, invite join in a separate context, quiet-hours voicemail record → inbox →
  phone "MISSED GRANDMA" → heard clears it. Not yet: real transcription run (needs
  TRANSCRIBE_URL or Workers AI login), passkeys on a real phone over HTTPS.
- M5 CLI + Tauri — not started.

## Client notes
- `packages/client`: `ProtocolSocket` (reconnect with backoff, 25s app ping), `CallMedia`
  (audio-only RTCPeerConnection; queues ICE until the remote description is set), `TonePlayer`
  (Web Audio call-progress tones; unlock on a user gesture).
- `apps/device-web` (vanilla TS): runs `deviceStep`; pure `leds.ts` and `strip.ts` (≤2 lines ×
  16 chars) with tests; `segments.ts` 14-segment SVG font. Query params: `?profile=` (separate
  identity per emulated phone; IndexedDB non-extractable Ed25519 key), `?keys=1-8`,
  `?display=eink|segments`. Keyboard: Space = hook, 1–8 = keys.
- `apps/companion` (React 19): `connection.ts` (socket + media), `calls.ts` (call UI state),
  `api.ts`, screens per file. Session token in localStorage; `#setup=<token>` runs first-run setup.

## M4 notes
- `ServerEnv` now also carries `blobs` (BlobStore), optional `transcriber`, `defer` (background
  work; Workers `waitUntil`), optional `publicUrl` (passkey RP id/origin; else request URL).
- Routes live in `http.ts` (setup, devices, allow-list, quiet hours), `people.ts` (invites,
  passkeys, removing people; public routes are registered before the auth middleware) and
  `voicemail.ts`. Shared helpers in `httpUtil.ts` (`body`, `guardianOnly`, `Vars`).
- Voicemail: `POST /api/devices/:id/voicemail?durationMs=` raw `audio/*` body ≤ 2 MB, caller must
  be on the allow-list with `canCallDevice`. Guardians: `GET /api/voicemails`,
  `GET /api/voicemails/:id/audio`, `POST …/heard`, `DELETE …`. Blob keys never leave the server.
- Single-use tokens (invites, WebAuthn challenges, pairing codes) check `changes === 1` on the
  DELETE; race tests in `store.test.ts` prove it.
- Self-host transcription: `TRANSCRIBE_URL` (OpenAI-compatible). Cloudflare: optional `AI`
  binding (commented out in wrangler.jsonc so `wrangler dev` works without login).

## Cloudflare notes
- Worker routes: `/api/*` → shared Hono API with a DO-RPC `Coordinator`; `/ws/device?device=` →
  household DO (looked up in D1) or the pairing DO; `/ws/app?household=` → household DO; the rest
  → static assets (`npm run assets` copies companion → `public/`, emulator → `public/device/`).
- `GatewayObject` base class: `acceptWebSocket`, attachments `{app, memo}`, `Gateway.resume` in
  the constructor after hibernation, `setWebSocketAutoResponse` for `{"t":"ping"}`.
- First-run on Cloudflare: `SETUP_TOKEN` secret is seeded as the setup token until a household
  exists (`seedSetupToken`). TURN: `TURN_KEY_ID` + `TURN_KEY_API_TOKEN` secrets, else STUN only.
- `@cloudflare/vitest-pool-workers` needs Vitest 4 (we use 5), so Worker testing is the shared
  e2e scenario against `wrangler dev` (`OTC_E2E_URL`, `OTC_E2E_SETUP_TOKEN`).

## Server architecture notes
- `Gateway` (packages/server-app/src/gateway.ts) owns the per-socket handshake. Devices: `hello`
  → unpaired: `pair.begin` → `pair.code` (waits; `pair.done` when a guardian POSTs
  `/api/devices/pair`) → device reconnects; paired: `auth.challenge` → `auth.proof` (Ed25519 over
  the raw nonce bytes) → `config`. Apps: `app.hello{token}` → `app.ready`.
- `HouseholdHub` (hub.ts) holds all live peers and call rooms for one household and serializes
  work through a promise queue. Calls never cross households, so on Cloudflare (M3) one Durable
  Object per household should wrap one hub. Party keys are `dev:<id>` / `usr:<id>`.
- Call signaling rule: **the party that placed the call sends the SDP offer** after both sides
  get `rtc.config` + `call.state connecting`. The hub marks the call `active` when it relays the
  SDP answer. Ring timeout 30s, connect timeout 20s.
- Refused calls (denied / busy / unreachable / voicemail) get a fresh callId and a single
  `call.state ended` — no room is created.
- Pairing a device auto-adds the pairing guardian as a contact (both directions, bypasses quiet
  hours) on button 0.
- REST: `/api/setup`, `/api/me`, `/api/users`, `/api/devices`, `/api/devices/pair`,
  `/api/devices/:id/contacts[/:userId]`, `/api/devices/:id/buttons/:index`, `/api/quiet-hours`.
  Bearer auth; guardian-only routes use the `guardianOnly` middleware.
- Self-host server: `node apps/server-selfhost/src/main.ts` (env: PORT, HOST, DATA_DIR,
  PUBLIC_URL, STUN_URLS, TURN_URLS, TURN_SECRET, COMPANION_DIR, DEVICE_DIR). Serves the companion
  at `/`, the emulator at `/device/`, WebSockets at `/ws/device` and `/ws/app`.
