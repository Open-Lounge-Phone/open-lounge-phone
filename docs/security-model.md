# Security model and trust

Status: **design** (2026-09-28). Items marked *(planned)* are not built yet.

## Hardware guarantees (hold even if the firmware is compromised)

- **Physical mute switch** cuts power to the base microphone.
- **Mic light is wired to the mic's power** *(planned circuit change)*. If the light is off, the mic
  is unpowered.
- **Handset is unpowered while hung up** *(planned circuit change)*. The hook sensor also switches
  off the handset port's power.
- **No camera, no radar.** Nothing on the board can see anyone.
- **Open hardware** (CERN-OHL-S): the schematic, layout and parts list are public.

## Firmware guarantees *(planned with the firmware)*

- **Secure boot and flash encryption** (ESP32-S3): only signed firmware runs, and a stolen phone's
  memory is unreadable.
- **Signed updates with anti-rollback protection**, installed only while hung up and idle.
- **Device key** generated on the phone and never exported. Removing the phone in the app makes it
  useless.
- **Debug ports locked** in production. Hobby builds get a clearly marked unlocked option.
- **Reproducible builds with published fingerprints.** The phone shows its firmware fingerprint so
  anyone can check it against the release.

## Network and service

- **Encrypted calls:** 1:1 calls use WebRTC (DTLS-SRTP), peer to peer. The TURN relay only forwards
  encrypted packets. The server and relay never hear 1:1 audio.
- **Group rooms (planned SFU):** encrypted in transit, but the relay could access the audio until
  end-to-end room encryption (SFrame) is added.
- **Default-deny calling**, enforced on the server. Kids' phones have no address and can't be
  knocked.
- **Federation:** signed server-to-server requests (RFC 9421), server-key pinning, blocklists and
  rate limits.
- **Lounge:** signing in needs a physical key press (proximity proof). Nothing stays on the phone,
  and the server keeps only who, where and when.
- **Data minimisation:** retention settings with automatic expiry. Transcription can be switched off;
  on Cloudflare it runs on Workers AI.
- **Hub operators can see metadata** (who called whom, and when), never call audio. For full
  assurance, run your own server.

## Trust signals people can see

1. **Owner and mode:** the strip always shows them, e.g. "Kids · Smith home", "Lounge · free" or
   "Signed in: Jesse".
2. **Lights and switches with a physical meaning:** the mic-power light, the mute switch, a separate
   recording light, and an unpowered handset while hung up. Recording is off unless a space enables
   it, and it is always announced.
3. **MENU → About:**
   - the firmware version and its fingerprint
   - a QR code linking to this board revision's public schematic
   - the device fingerprint as **four words**, matching what the app shows at pairing
4. **Open-hardware marking on the board**, standard screws, an optional clear shell, and an optional
   tamper-evident seal for venues.
5. **Lounge:** a visible sign-in, a big "Log out", and a "Forgot you ✓" confirmation.
6. **In the app, per device:**
   - the four words
   - firmware status and last seen
   - remove and wipe
   - the Lounge usage history
