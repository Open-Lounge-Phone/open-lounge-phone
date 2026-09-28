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
