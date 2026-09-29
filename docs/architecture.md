# Architecture

```
 ┌──────────────┐   WebSocket (protocol v1)   ┌───────────────────────────────┐
 │ Phone        │◀──────────────────────────▶│ Backend (pick one)            │
 │  web emulator│                              │  • Cloudflare: Worker + DOs,  │
 │  desktop app │   WebRTC audio (Opus)        │    D1, R2, Realtime SFU       │
 │  ESP32-S3    │◀──────── p2p or SFU ───────▶│  • Self-host: Node + SQLite + │
 └──────────────┘                              │    coturn (Docker)            │
        ▲                                      └───────────────────────────────┘
        │ WebRTC audio                                   ▲ WebSocket + HTTP
        ▼                                                │
 ┌──────────────┐────────────────────────────────────────┘
 │ Companion app│  guardians: allow-list, buttons, quiet hours, voicemail, battery
 │ (PWA)        │
 └──────────────┘
```

## Layers

| Layer | Package | Runs on |
|---|---|---|
| Wire protocol | `packages/protocol` | everywhere |
| Domain logic (ACL, quiet hours, call/room/device state machines) | `packages/core` | everywhere; mirrored in firmware |
| Storage schema (Drizzle, shared by D1 and SQLite) | `packages/db` *(M2)* | servers |
| HTTP/WS app written against backend interfaces | `packages/server-app` *(M2)* | servers |
| Media providers: `p2p` (STUN/TURN) and `cloudflare-realtime` (SFU) | `packages/media` *(M2–M3)* | servers + clients |
| Entry points | `apps/server-selfhost`, `apps/server-cloudflare` | Node / Workers |
| Clients | `apps/device-web`, `apps/companion`, `apps/device-desktop` | browser / Tauri |

The backend is pluggable: only the entry point and the implementations of `Storage`, `Hub`
(WebSocket fan-out), `MediaProvider`, `BlobStore`, and `Transcriber` differ between Cloudflare
and self-host.

## Key flows

**Accounts, households and memberships.** A person has one **account** per server, with a
unique, changeable **handle**; their address is `handle@host` (e.g. `jesse@l1.openloungephone.app`).
A **household** holds phones, quiet hours and an allow-list per phone. A **membership** (a
`users` row with `account_id`) is the account's role in one household (guardian or contact), and
one account can belong to several households (co-parents, grandparents). Passkeys and sessions
belong to the account; a session remembers its **active household**, and a client can pin a
request to another of its own households with the `x-household` header (the companion does, per
tab) or name it in `app.hello.household`. Every existing route acts inside the active household,
and asking for a household the account isn't in is refused (403). Ways in:
- the first-run setup link creates the first household (unchanged);
- **open sign-up** (`OPEN_SIGNUP=1`, off by default): pick a handle, create a passkey → account
  plus a personal household (`POST /api/signup/options`, `POST /api/signup`);
- an **invite link**: signed out it creates a new person; signed in it adds a membership to your
  account;
- **Add a household** (`POST /api/households`): any account on an open server, or a guardian on
  an invite-only one.

A household is one kind of **space** (`type`: `home`, `team` or `org`; `POST /api/spaces`).
Kids' phones and quiet hours exist only in homes; team and org spaces hold grown-ups' own phones
and Lounge phones. A released handle stays reserved for its last owner for 90 days.

**Connections.** Grown-ups reach people outside their spaces through **connections**: knock on
`handle@host` (`POST /api/connections`), and once the other person accepts, both have an
`active` connection. The same code handles a person on this server or on another one; another
server is reached with signed `/fed/v1` requests (RFC 9421, Ed25519 server keys published at
`/.well-known/openloungephone`, pinned on first use, see [federation.md](federation.md)). A
guardian may put an active connection on a kid's phone's allow-list.

**Calls between households and servers.** A call to a connection opens a room in the caller's
household hub whose far end is a *proxy peer*; the callee's server authorizes on its own terms
and opens the matching room. Signaling flows between the two rooms: hub to hub on one server, or
over the on-demand, signed **server-pair stream** (`/fed/v1/stream`; a `FederationObject`
Durable Object per remote host on Cloudflare) between servers. Media stays peer-to-peer; each
side uses its own TURN; clients use Opus DTX. `packages/federation` holds
the web-standard crypto and message schemas; `packages/server-app/src/connections.ts` and
`federation.ts` the server side.

**Running a public server.** Open sign-up can be protected with Cloudflare Turnstile, per-IP and
per-account rate limits, and a monthly **fair-use allowance** (`FAIR_USE=hub`; checked when a call,
voicemail or knock starts, metered in the `usage` table when it ends; calls in progress are never
cut off). Every call writes a **call log** row per party (`call_log`), the base for a per-buddy
timeline. Operators (`OPERATORS`) get an admin view to suspend or exempt accounts and block
servers. People can download their data (`GET /api/account/export`, [export.md](export.md)) and
delete their account. See [hub.md](hub.md) and [privacy.md](privacy.md).

Calling rules don't change: `authorizeInbound` / `authorizeOutbound` still decide every call, and
calls stay inside one household until federated connections (see
[federation.md](federation.md)) add grown-up ↔ grown-up reachability through an accepted
"knock". There is no bridge to the phone network (PSTN), ever.

**Pairing.** An unpaired phone generates an Ed25519 keypair, sends `pair.begin`, shows the
returned 6-digit code on its e-ink status strip, and reads it aloud when the handset is lifted. A guardian enters it in the companion app; the server binds the public key
to the household and sends `pair.done`. Every later connection is a signed `auth.challenge`, so
no shared secret is ever stored on the device.

**Outbound call.** Handset up → button → server resolves the button to a contact and calls
`authorizeOutbound` (default-deny, quiet hours) → a call room rings the contact's companion app →
both sides negotiate media via the configured provider → handset down ends the room.

**Inbound call.** A contact dials the phone → `authorizeInbound`. Outside quiet hours the phone
rings. During quiet hours the caller records a voicemail instead; it is stored in the blob store,
transcribed (Workers AI Whisper or a local whisper.cpp), and shown to guardians. The phone never
rings.

**Any device as a phone.** The browser phone (`apps/device-web`, served at `/device/`) is an
installable web app with its own manifest and service worker. On a small or installed screen it
goes full screen with the 12 keys, the status strip and a big lift/hang-up control, keeps the
screen on (Screen Wake Lock) and redials when the network comes back. Its first-run screen picks
**Kids phone** or **Lounge phone**; the choice travels in `pair.begin.kind`.

**Lounge phone (takeover).** A device with `kind = 'lounge'` has no allow-list of its own. While
free it shows a QR code for `<server>/lounge#<deviceId>.<nonce>` (`lounge.idle`); the nonce is
single-use and expires after 2 minutes; the phone asks for a new one (`lounge.refresh`) only
while the code is on screen, and the server never rotates it on a timer, so a quiet Lounge phone
lets its household's Durable Object hibernate. A member scans it and sends `lounge.claim`; the hub rotates
the nonce, and the phone flashes a random key (`lounge.challenge`) that must be pressed on the
phone (`lounge.press`) within 30 s — the proximity proof. The phone then *stands for* that
person (`personOf` in `hub.ts`): calls to them ring it (`reachable`), and its keys dial their
speed-dial as if they called from their app (`appDial`/`userDial` with the person as the caller
identity, so `authorizeInbound` and the availability rules decide — exactly their own
permissions). The session is ephemeral: it ends on MENU → Log out (`lounge.leave`), Leave in the
app, the household's idle timeout while hung up (`households.lounge_idle_minutes`, default 10),
a new takeover, or a disconnect that lasts over 60 s (a reconnect within 60 s resumes the session;
the deadline uses the hub's single `wakeAt` alarm, shared with quiet hours); the phone gets `lounge.ended` and forgets everything. The server
keeps only a `lounge_sessions` row (who, where, when) for guardians. "Open to chat"
(`lounge.chat`, a MENU item) and the person's location travel in `member.status.lounge`.

## Phases beyond software

The phone has **no main screen**: keycapped keys with per-key LEDs, a small e-ink status strip,
handset audio, a ringer speaker, and radios and sensors. Hardware details and part choices live in [hardware/DESIGN.md](../hardware/DESIGN.md).

1. **Lounge variant hardware** — the software flow above works today with the on-screen QR
   code; hardware adds a printed QR/NFC tag on the base, NFC tap and mmWave presence as further
   proximity proofs, "open to chat" on key LEDs, and a presence-based dead-man logout.
2. **Firmware** — ESP32-S3 (ESP-IDF, FreeRTOS, esp-webrtc) on off-the-shelf dev boards with an
   audio codec, handset earpiece/mic, and MX-style key switches with per-key LEDs, implementing
   the same protocol and the `deviceStep` state machine from `packages/core`.
3. **Custom PCB** — a single base board in a Trimline-style corded phone: bare, passive handset;
   USB-C power; hot-swap keyboard switches with keycaps; mmWave presence, hall-effect hook
   sensing, light sensor, BLE/NFC for provisioning and lounge proximity.
