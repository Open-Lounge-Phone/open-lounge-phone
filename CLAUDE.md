# Open Lounge Phone — notes for agents

Open-source, screen-free intercom phone. Software phase first (runs on computers), then ESP32-S3
firmware, then a custom PCB in a Trimline-style corded phone powered by USB-C. Read
`README.md` (status table), `docs/architecture.md`, and `docs/protocol.md` before changing code.
Hardware design lives in `hardware/DESIGN.md` (proposal r0.1: ESP32-S3-WROOM-1-N16R8,
ES8311+ES7210+NS4150B audio with hardware AEC reference, USB-C handset port (see below), 12 MX hot-swap
keys with SK6812MINI-E LEDs, 2.9" e-ink strip between key rows, DRV5032 hall hook, USB-C →
BQ24074, LD2410C radar on Lounge, ST25DV NFC; its §13 lists protocol recommendations such as
key-algorithm negotiation ed25519|p256, per-key LED/strip messages, audio prompt ids). Its open
questions are the owner's to answer — don't decide them silently.
The board is captured as **schematic-as-code in SKiDL** (`hardware/schematic/`,
`make build` in `hardware/`, venv in `hardware/.venv`, see `hardware/SCHEMATIC.md`), ERC + custom
checks (pin table, I2C addresses, LCSC/footprint validity). Open questions are parameters in `config.py`.
**ONE BOARD, ONE DESIGN (owner decisions 2026-09-28; supersedes every variant/deck/Lite/Qwiic/
radar mention below):** a single 180 × 88 mm 4-layer board (`hardware/kicad/main/`,
`hardware/build/main/`) with the keys, e-ink ZIF + booster, NFC (ST25DV + coil), and the battery
charger + fuel gauge all populated. No build variants and no separate deck board (the two stacked
boards were left over from the old long base). Removed: LD2410C radar (Lounge presence is deferred
to a possible future board), ATECC (flash encryption + eFuse HMAC instead), Qwiic port, supercap.
Perfect this one board; don't design options.
**Device modes (owner, 2026-09-28; `docs/device-lifecycle.md`, `docs/security-model.md`):**
- Three modes: Kids (always the child), Personal/desk (always one person) and Lounge.
- Lounge is dead until someone signs in by default. The per-space idle configs (house-line keys,
  who's here) are all off by default.
- Session length is a per-space setting managed by the space's operators/admins.
- No claim lock: removing a phone wipes it, and anyone can re-claim it.
**Layout method (owner, 2026-09-28):** placement comes first, laid out as a standard board.
- Blocks are local hubs next to what they connect to. GND is the L2 plane and power runs on L3 pours, reached by vias.
- Buses run in planned lanes: keys as parallel row buses into the AW9523B at the row ends, the I2C spine, and the I2S/SPI bundles.
- Show the owner the placement (`make review` → `build/review/placement.png`) before routing.
- Route block by block (LAYOUT.md plan A–E), not with an unconstrained autorouter.
- Keep silkscreen clear of pads, parts and other silkscreen (these DRC checks are errors).
**Display & cost (owner decisions 2026-09-27):** Kids ships as **Lite** by default — no display;
printed relegendable keycap labels (companion: Manage phone → "Print key labels"), LEDs + voice.
**E-ink 2.9" (GDEY029T94) is the standard option** (Kids Standard, Lounge); cheaper displays
(0.91" SSD1306 OLED @0x3C, HT16K33 14-seg @0x70) plug into an optional Qwiic/STEMMA-QT I2C port on
the deck. `hello.display` = eink | seg14 | oled | none. Cost goal (revised): **$28–40 per phone is
fine**; it must be **affordable to build one-off** (a hobbyist's minimum JLCPCB order) and
**cheap at scale**. The hardware build reports both per variant; prefer JLC "basic" parts where
function allows (extended parts add setup fees that dominate small orders).
**Manufacturing: JLCPCB first, portable always (owner, 2026-09-27):** JLCPCB is the primary
target (cheapest; optimize for its basic parts, formats and stackup), but outputs must also work
at any other PCB/PCBA house
(JLCPCB, PCBWay, OSH Park, Eurocircuits, Aisler, Epectec, Seeed, NextPCB, MacroFab, …) and for
bare boards + self-sourced parts + hand assembly: design rules = common 4-layer capability
(≥0.15 mm trace/space, ≥0.3 mm drill), Gerber X2 + Excellon + IPC-2581, generic BOM (MPN +
LCSC/DigiKey/Mouser) and pick-and-place, plus a hand-assembly difficulty guide.
**Keys (owner decision 2026-09-27, final):** 12 keys in two rows of six:
`1 2 3 4 5 MENU` / `6 7 8 9 0 BACK`, e-ink strip between the rows centered over the digit columns.
The strip is **representational**, not physically aligned: it draws two rows of labels in the
same order as the keys. Digits 0–9 are essential (dialing, entering codes); pressing a digit selects whatever the
strip shows for it; MENU opens the menu, BACK steps out; no ENTER/SPEAKER/END keys (hang up = hook;
speakerphone is a menu item). Kids Lite uses a voice menu with the same keys. Protocol `button`
index: digits 1–9 → 0–8, digit 0 → 9 (speed-dial slots); MENU/BACK are handled on the device.
**Form factor (owner decision 2026-09-27, supersedes the long 350 mm in-line base):** a
modified Trimline silhouette where a **G-style handset** (classic dumbbell desk-phone handset)
rests on a **raised metal hook rest** (bent rod or folded sheet; printed option for DIY) **above
the keypad**, with finger clearance so the 12 keys and e-ink strip stay visible and usable while
hung up. The rest's **hook plunger dips under the handset's weight and carries a magnet over the
hall sensor** (literal on/off the hook, no wearing contacts; any G-style handset works — no magnet needed
in the handset). Base ≈ handset footprint (~240 × 110 mm);
key deck on top, main board stacked beneath via the FFC. Owner references: `hardware/art/reference-base-top.png`
(top view of the base without the handset: rounded cream slab that is essentially the keypad deck,
2×6 keys + e-ink strip, framed by a dark metal frame that rises into the hook rest) and
`hardware/art/reference-trimline.jpg` (the Trimline silhouette to echo). Handset: the owner likes the concept stills; the
handset must match a **real Western Electric G-style handset** in size and shape (faceted/chamfered
handle, domed angled earpiece and mouthpiece cups) — references `hardware/art/reference-g-handset.jpg`
(vintage G handset) and `hardware/art/reference-handset-modern.jpg` (modern glossy take). **Chosen proportion: A — Compact**
(base ≈186 × 94 × 33 mm; the G handset overhangs the base ends; main board ≈180 × 88 mm under
the key deck; hall sensor under one hook post; side buttons on the main board edge; 20 × 40 mm
rectangular speaker). **Construction (owner):** simple
and easy to fabricate — base = two printed pieces (top shell + bottom tray, self-aligning lip)
closed with screws from below into brass heat-set inserts; clean sloped/chamfered edges that print
without supports; **drop-in metal posts** (off-the-shelf rod/tube, straight cuts) for the hook rest;
low part count; customizable by shell colour, post finish and keycaps.
**Name (owner decision 2026-09-27):** the project is **Open Lounge Phone** (slug/package scope
`openloungephone`, `@openloungephone/*`). It was briefly named after tin cans, but "Tin Can" is a
registered trademark of another phone. The owner has confirmed "Open Lounge Phone" is clear
and unregistered — never use "tin can", "TinCan", "opentincan" or "ORT" in
code, UI, docs, silkscreen or new commits. (The working-directory folder name `opentincan/` on
the owner's machine is incidental.) Self-host auto-renames a legacy `opentincan.sqlite`.
**Board marking (owner):** every board carries the owner's signature logo (`hardware/art/signature.jpg`,
traced to a silkscreen footprint with strokes thickened to ≥0.2 mm) and the text
"Open Lounge Phone".
**Handset connection (owner decision 2026-09-27, supersedes RJ9):** **no RJ9/4P4C**. The handset
connects with a **standard USB-C to USB-C cable** and the base works with **off-the-shelf USB-C
headsets/handsets**: digital USB Audio Class (UAC 1.0) with the ESP32-S3's native USB as **host**
on a dedicated handset USB-C port (current-limited VBUS). We **use an off-the-shelf G-style USB-C
handset** (Native Union POP-style) rather than building one; the cradle fits it and a classic G handset. Flashing/console moves to a USB-UART bridge on the power USB-C port. Analog audio-accessory
mode is not used (most C-to-C cables lack the SBU wires it needs).
**Swappable by design (owner, 2026-09-27):** shells are 3D-printable in any colour
(`hardware/enclosure/`, code CAD), the handset cord is a **standard USB-C to USB-C cable** (coiled or not), keys
are standard MX switches + 1u keycaps (12 of them) — all interchangeable/customizable. The
default look is clean and utilitarian; the site's `/customize/` three.js configurator shows the
swaps (loads real GLBs from `hardware/enclosure/build/web/` when present).
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
- **Variants (software):** Kids first; Lounge features (QR takeover, presence, ephemeral sessions) later. Hardware is one board (see top).
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
  Every unanswered call (no answer, declined, busy, quiet hours, unavailable, offline) offers it
  via a single-use ticket in `call.state.voicemail`; see "Voicemail everywhere" below.
- **Storage:** plain SQL migrations in `packages/db/migrations` shared by D1 and `node:sqlite`
  (no Drizzle, no native modules). Self-host tracks applied migrations in the same
  `d1_migrations` table wrangler uses.
- **Guardian auth (interim):** first run prints a one-time setup link (`/#setup=<token>`) that
  creates the household + first guardian and returns a bearer session token. Passkeys come in M4.

- **Owner, 2026-09-28:** connections are also called **buddies** in docs/UI copy (code name stays
  `connections`); there is **no text chat**.

## Conventions
- **Docs stay current (owner rule, 2026-09-28):** every feature or phase updates README.md, `docs/`,
  the site (`apps/site/src/content-src/`) and hardware docs in the same change; superseded claims
  are removed, and future work is marked as planned. Site and hub footers say "Proudly supported by
  unsubscribe.llc" (https://www.unsubscribe.llc/). Donations go through GitHub Sponsors via a single
  `SPONSOR_URL` config (hidden until set, never a placeholder). The hub is free and donation-funded.
  For full security, people run their own server.
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
- **Live instance (owner):** `l1.openloungephone.app` deployed 2026-09-27 with
  `apps/server-cloudflare/scripts/deploy.ts --instance l1 --domain l1.openloungephone.app`
  (Worker `openloungephone-l1`, D1 `openloungephone-l1`, R2 `openloungephone-l1-voicemail`, AI
  on, TURN not yet). The owner's Cloudflare account hosts OTHER projects — only ever touch
  resources named `openloungephone-*`. Root `openloungephone.app` = project site
  (`apps/site`, Astro Starlight).
- **Phone app + Lounge (2026-09-28, `8dae4be`, `77fb911`; not yet deployed to l1):** `/device/` is
  an installable phone app (own manifest + service worker, fullscreen touch layout with a big
  handset button, wake lock, first-run Kids/Lounge choice), so any old phone/tablet can be the
  phone. Lounge: device `kind: "lounge"` (migration `0005_lounge.sql`), QR takeover with a
  rotating single-use nonce + press-the-flashing-key proximity proof (30 s), ephemeral sessions
  (Log out / Leave / idle timeout, default 10 min / new takeover / disconnect) that leave nothing on the
  phone, "open to chat" presence (MENU → 5), and a companion `/lounge` scan page plus a Lounge phones
  section. The server keeps only who, where and when.
- M5 CLI + Tauri — deploy script done (seed of the CLI); rest not started.
- **P1 accounts + several households (2026-09-28, F0):** migration `0006_accounts.sql`
  (accounts with unique handles `handle@host`, `users` = memberships with `account_id`, sessions
  and passkeys on the account; backfill derives de-duplicated handles from names). Active
  household per session, `x-household` header / `app.hello.household` to pin one (must be your
  own). `POST /api/signup[/options]` behind `OPEN_SIGNUP=1` (self-host env; Cloudflare var via
  `deploy.ts --open-signup`; default off), `POST /api/households`, `PUT /api/me/household`,
  `PATCH /api/account` (handle once a day), invite accept while signed in adds a membership.
  Companion: sign-up/invite/sign-in chooser, handle picker, household switcher, "Add a kid's
  phone / Invite a co-guardian / Add a household". Not yet deployed to l1.
- **P1b spaces + handle reservation (2026-09-28):** migration `0007_spaces.sql` (additive:
  `households.type` home|team|org default home; `released_handles`). A household is a **space**
  (table name unchanged; `Space = Household` in the store); `POST /api/spaces {name,type}` (and
  `/households` with `type`); `/me` memberships carry `spaceType`. Kid-safety only in homes:
  kids' (unowned) phones refused elsewhere, `/quiet-hours` PUT refused and `getSchedule` returns no
  rules outside homes. Released handles (rename or leaving the last space) stay reserved 90 days
  for their last owner (`handleAvailable`, conditional inserts). UI says "household" for homes,
  "team"/"organization" otherwise. Tests: `spaces.test.ts`; shared harness `testkit.ts`.
- **P2 connections + knocks, local and federated (2026-09-28, F1):** migration
  `0008_connections.sql` (additive: `connections`, `remote_contacts`, `remote_buttons`,
  `rate_limits`, `server_keys`, `fed_nonces`, `blocked_servers`). New `packages/federation`
  (RFC 9421 Ed25519 sign/verify via WebCrypto, key gen/load as JWK, `.well-known` schema with
  signed rotation, `handle@host` parsing, `/fed/v1` bodies). Server: `connections.ts` (knock /
  accept / decline / block / disconnect / block-server; same code for local and remote;
  `federationApp` = `/.well-known/openloungephone` + `/fed/v1/{knock,connections/accept,
  connections/remove}`), `federation.ts` (TOFU key pinning, `fedFetch`, `verifyFedRequest`:
  ±5 min, nonce cache, operator blocklist, per-server budget), `limits.ts` (one config object).
  Every knock answers the same (no enumeration). Kid phones have no address; guardians add active
  connections to allow-lists (`rc_…` entries, also on speed-dial keys). Keys: CF secret
  `FED_PRIVATE_KEY` + var `PUBLIC_URL` (deploy.ts), self-host `DATA_DIR/federation-key.jwk`,
  `.localhost` hosts go to loopback. Protocol: `connections.changed` (additive). Companion:
  Connections tab (address + copy + QR, Add by address, knocks inbox, waiting, blocked), allow-list
  picker with `@host` badges. Tests: `connections.test.ts` (mutation-checked),
  `federation/signature.test.ts`, `tests/e2e/twoServers.test.ts` (two real self-host processes).
- **P3 federated calls, voicemail, presence, Lounge guests (2026-09-28, F2):** migration
  `0009_federated_calls.sql` (additive columns `accounts.share_presence`,
  `connections.presence_*`, `households.lounge_guests`; new `connection_phones`, `lounge_away`;
  `lounge_sessions` rebuilt with nullable `user_id` + `guest_address/guest_name`, rows copied).
  Hub: proxy `remote` peers (`FedConn`, call legs), `connectionDial` / `connectionPhoneDial` /
  `remoteContactDial` / `dialRemote` (placement outside the queue), `remoteRing`, `remoteSignal`,
  guests (`guestClaim`, `startGuestSession`, `guestDial`, `relayDial`). `fedCalls.ts` (callee-side
  authorization, placement, loopback between households), `fedStream.ts` (`ServerLink`: signed
  in-band hello, ordered sends, on-demand dial, 60 s idle close via alarm, hibernation `adopt`),
  `fedLinks.ts` (in-process registry). Cloudflare `FederationObject` (DO per remote host,
  migration tag v2) + `/fed/v1/stream` route. Protocol (additive): `call.connection`,
  `call.phone`, `lounge.progress.host`. Client: Opus DTX (`withOpusDtx`). Companion: Call on
  connections and their shared phones, presence dots + "Share my availability", remote
  voicemail, guest Lounge flow, guardian "guests" toggle. Browser-verified: cross-server call
  (a.localhost ↔ b.localhost) reaches WebRTC `connected` with DTX. Tests: `calls.test.ts`
  (mutation-checked), e2e extended with call + voicemail.
- **P4 public hub, code only (2026-09-28; NOT deployed):** migration `0010_hub.sql` (additive:
  `usage`, `call_log`, `accounts.suspended_at`, `accounts.fair_use_exempt`). Owner decisions: the
  hub is **free, donation-funded** (GitHub Sponsors via one `SPONSOR_URL` setting, hidden while
  unset; no paid plan); a **fair-use allowance** (`limits.ts` `FairUse`, `FAIR_USE=hub` +
  `FAIR_USE_*`, unlimited when unset; hub defaults 1,000 min / 100 voicemails / 100 MB / 100 knocks
  per month, 5 phones per space, 5 spaces per account) checked at start, metered at end
  (`fairUse.ts`, hub `allowance`/`payer`), operators can exempt; `call.state.note` (additive)
  explains refusals. Turnstile on sign-up (`TURNSTILE_SITE_KEY/SECRET`), per-IP (hashed) and
  per-account limits, suspension, operator view (`OPERATORS`, `hubAdmin.ts`), `/api/usage`,
  `/api/hub` (funding via `packages/core` `fundingSummary`, tested), `call_log` rows at every call
  end (by account + peer, for the P2b buddy timeline), export + delete account (`leaving.ts`,
  `docs/export.md`). Companion: Turnstile widget, fair-use and funding cards, Sponsor button,
  "Proudly supported by unsubscribe.llc" credit, Operator tab, Your data (download / delete),
  "Connections (buddies)". deploy.ts: `--open-signup` requires TURN and sets `FAIR_USE=hub`;
  `--turnstile-*`, `--operator`, `--funding-balance`, `--sponsor-url`. Site: three-path Getting
  started, funding page + home card (computed), hub/privacy/export/federation pages, footer
  credit (+ Sponsor when `SPONSOR_URL` is set at build). Docs: `docs/hub.md` (costs, allowance),
  `docs/privacy.md`, `docs/export.md`. Tests: `hub.test.ts` (mutation-checked), `funding.test.ts`.
- **Step 1 fixes (2026-09-28):** a call to a person rings everywhere they are (their other spaces:
  apps, own phones, Lounge phone; and a Lounge phone on another server where they're a guest,
  via `/fed/v1/calls` target `guest`) as proxy "branches" of the call owned by their first space
  (`HouseholdHub.branchesFor/ringAll/dropBranch`, `CallLinks.ringLocal`); first answer wins, a
  decline ends it. Knock notice: "If <address> exists, they'll get your request." Cloudflare
  verified locally: `tests/e2e/cloudflare.test.ts` (opt-in, `OLP_E2E_CLOUDFLARE=1`) runs the
  two-server scenario on two `wrangler dev` instances incl. the FederationObject idle close;
  `DEV_LOOPBACK=1` is the dev-only `*.localhost` switch.
- **Voicemail everywhere + greetings (2026-09-29):** migrations `0011_presence_pending.sql`
  (coalesced presence) and `0012_voicemail_everywhere.sql` (`voicemails` rebuilt: `device_id`
  nullable + `to_user` + `from_address`, call_log links kept; `voicemail_prefs` per account/phone:
  ring seconds, child may record, greeting blob; `voicemail_tickets`). Hub: `room.vm`
  (target + caller) set at dial, offer on `refuse`/`apply(ended)` when `goesToVoicemail`
  (`packages/core/voicemail.ts`), per-callee ring time (`RING_TIMEOUT_MS` 25 s default, remote
  legs use a 65 s backstop), `greeting.begin/reset` from phones. `vmTickets.ts`: public
  `/api/vm/{greeting,message}` (and `POST /api/vm/greeting` for phones), delivery to a person,
  phone or connection (`/fed/v1/voicemail kind=person`, `/fed/v1/greeting` in connections.ts,
  active connection required). `voicemail.ts`: inbox for everyone (own + guardians' phones),
  `/api/voicemail/{settings,greeting}`, `/api/devices/:id/{voicemail,greeting}`. Protocol
  (additive): `call.state.voicemail`, `config.greeting`, `greeting.begin/reset/ticket/done`,
  `voicemail.inbox`, `VoicemailPrompt` ids for firmware. Client: `recorder.ts`, `voicemail.ts`
  (`LeaveMessage`, `browserVoice`). Companion: `LeaveVoicemail` (greeting → tone → record → Hang up
  & send), `GreetingEditor` (Voicemail tab; phone Manage page), Voicemail tab for all members.
  Browser phone: `voicemail` device state, MENU → Voicemail → 1 name / 2 greeting / 3 default.
  Fixes: presence rate limit coalesces (hub alarm), `#invite=` on hashchange, "Use this phone"
  waits for the socket. Tests: `voicemail.test.ts` (mutation-checked), e2e `noAnswerAcross`,
  live checks 22–23 (not run against production). Guest-at-Lounge relay calls don't offer voicemail yet.
- **Roadmap:** follow the approved plan `~/.claude/plans/we-build-on-this-dapper-wand.md`
  (P1 accounts ✔ → P1b spaces ✔ → P2 knocks/connections ✔ → P3 federated calls ✔ → P4 public hub ✔ (code; not deployed) → P5 interop).
  Owner decisions 2026-09-28: knock-then-talk, no PSTN ever, public hub + own servers as equals.
  The M6 multi-server companion is **dropped**: one home account reaches everyone via federation.
  - **Federation (owner, 2026-09-27) — design in `docs/federation.md`:** people connect across
    servers with single-use connection links (`name@host` addresses, server Ed25519 keys at
    `/.well-known/openloungephone`, RFC 9421 signed requests), default-deny everywhere (each
    server authorizes its own users/phones), calls signaled over a per-server-pair stream with
    p2p media, fair rate limits and blocklists, no central directory. Phases F0 (multi-household
    on one server + one account in several households) → F1 connections → F2 federated calls →
    F3 phone↔phone → F4 interop tests.
  - **M7 public-good service:** a multi-household instance run by the owner (e.g.
    `hub.openloungephone.app`) for people who don't want to host: open household sign-up with
    abuse controls (Turnstile, rate limits, quotas), privacy policy/retention, backups. The server
    already supports many households; the gap is sign-up and operations.

## Client notes
- `packages/client`: `ProtocolSocket` (reconnect with backoff, 25s app ping), `CallMedia`
  (audio-only RTCPeerConnection; queues ICE until the remote description is set), `TonePlayer`
  (Web Audio call-progress tones; unlock on a user gesture), `VoicemailRecorder`, and
  `LeaveMessage` (fetch greeting → play → tone → record → upload with the offer's ticket).
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
  e2e scenario against `wrangler dev` (`OLP_E2E_URL`, `OLP_E2E_SETUP_TOKEN`).

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
