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

**Pairing.** An unpaired phone generates an Ed25519 keypair, sends `pair.begin`, and shows the
returned 6-digit code. A guardian enters it in the companion app; the server binds the public key
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

1. **Lounge variant** — QR identity takeover, presence ("open to chat"), ephemeral sessions with
   a dead-man logout.
2. **Firmware** — ESP32-S3 (ESP-IDF, FreeRTOS, esp-webrtc) on off-the-shelf dev boards with
   INMP441 mic, MAX98357A amp, SPI e-ink, mechanical switches, implementing the same protocol and
   the `deviceStep` state machine from `packages/core`.
3. **Custom PCB** — KiCad board adding LD2410 mmWave presence, AH3144 hall-effect hook switch,
   MAX17048 fuel gauge, BH1750 light sensor, TP4056/DW01A 18650 power path.
