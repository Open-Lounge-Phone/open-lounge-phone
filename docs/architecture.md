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

## Phases beyond software

The phone has **no main screen**: keycapped keys with per-key LEDs, a small e-ink status strip,
handset audio, a ringer speaker, and radios and sensors. Hardware details and part choices live in [hardware/DESIGN.md](../hardware/DESIGN.md).

1. **Lounge variant** — takeover via a printed QR/NFC tag on the base plus a proximity proof
   (press the flashing key, NFC tap, or mmWave presence), "open to chat" presence on key LEDs,
   ephemeral sessions with a dead-man logout.
2. **Firmware** — ESP32-S3 (ESP-IDF, FreeRTOS, esp-webrtc) on off-the-shelf dev boards with an
   audio codec, handset earpiece/mic, and MX-style key switches with per-key LEDs, implementing
   the same protocol and the `deviceStep` state machine from `packages/core`.
3. **Custom PCB** — a single base board in a Trimline-style corded phone: bare, passive handset;
   USB-C power; hot-swap keyboard switches with keycaps; mmWave presence, hall-effect hook
   sensing, light sensor, BLE/NFC for provisioning and lounge proximity.
