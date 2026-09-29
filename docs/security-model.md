# Security model and trust

Status: 2026-09-28 design; the software side is **built** (the four-word fingerprint, the device
page, remove and wipe, retention defaults and transcription per space). Items marked *(planned)*
are not built yet; recording is designed below and built later.

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
- **Data minimisation:** retention settings with automatic expiry, per space and per person (see
  below). Transcription can be switched off per space; on Cloudflare it runs on Workers AI.
- **Hub operators can see metadata** (who called whom, and when), never call audio. For full
  assurance, run your own server.

## Trust signals people can see

1. **Owner and mode:** the strip always shows them, e.g. "Kids · Smith home", "Lounge · free" or
   "Signed in: Jesse".
2. **Lights and switches with a physical meaning:** the mic-power light, the mute switch, a separate
   recording light, and an unpowered handset while hung up. Recording is off unless a space enables
   it, and it is always announced.
3. **MENU → About:**
   - the firmware version and its fingerprint *(firmware fingerprint planned)*
   - a QR code linking to this board revision's public schematic *(planned with the board)*
   - the device fingerprint as **four words**, matching what the app shows at pairing (built; the
     browser phone shows them under MENU → 0 and says them aloud)
4. **Open-hardware marking on the board**, standard screws, an optional clear shell, and an optional
   tamper-evident seal for venues.
5. **Lounge:** a visible sign-in, a big "Log out", and a "Forgot you ✓" confirmation.
6. **In the app, per device** (the phone's page): the four words, the software it runs (firmware
   or browser-phone version, from its `hello`) and when it was last seen, **Remove and wipe**, and
   for Lounge phones the usage history (Lounge settings).

## The four-word device fingerprint

The words are derived from the phone's public key, so the phone and the server compute them on
their own and a person can compare them: `FINGERPRINT_WORDS[b]` for the first four bytes `b` of
SHA-256 of the raw public key (as sent in `pair.begin`), from a fixed list of 256 short, common
words in `packages/core/src/fingerprint.ts` (never reordered; firmware carries the same list).
The companion shows them before pairing ("Check these words match the phone"), after pairing and
on the phone's page; the phone shows them under MENU → About. 32 bits are enough to notice that the
code on the screen belongs to a different phone; they are not a secret.

## Retention and transcription

- **Per space** (guardians, `PUT /api/space/privacy`): how long call history and the Lounge
  usage history are kept (`history`), and voicemail (`voicemail`): 30 days, 1 year or forever
  (the default, as before). And whether voicemail is **transcribed** (on by default); off, the
  audio is never sent to speech-to-text and messages show "no transcript".
- **Per person:** their own setting comes first — per connection, then their account default
  (see the buddy timeline in [architecture.md](architecture.md)); the space's default applies
  when they have none, and to the space's phones.
- Expired rows and their audio are deleted by a sweep: daily when self-hosted, on activity in the
  space on Cloudflare (no timers), and always before a timeline or inbox is shown.

## Recording (design; built in batch C)

Not built: nothing records calls today. The design, so the rest of the system leaves room for it:

1. **Off unless a space turns it on** (guardians/admins, per space; never in a home's kids'
   phones, and never on a call with a kids' phone). It's a property of the recording side's
   space: a person can't silently record someone else's call.
2. **Always announced to everyone on the call**: a spoken prompt at the start ("This call is
   recorded") that the far side hears — including callers from other servers — plus the phone's
   separate **recording light** and a mark in the apps. A new optional `call.state.recording`
   field (additive) tells every party; firmware drives the light from it. A party who doesn't
   accept hangs up; there is no hidden mode.
3. **Where it is made:** 1:1 calls are peer to peer and the server never hears them, so the
   recording is made by the recording side's own client (app or phone) and uploaded like a
   voicemail — the server still never gets live audio. Group rooms (SFU, P3.5) would record at the
   SFU and are announced the same way.
4. **Where it lands:** a blob plus a row linked to the call-log row, shown in the buddy timeline
   ("recordings" there), transcribed only if the space transcribes, exported like voicemail, and
   expiring with the space's (or the person's) history retention.
5. **Across servers:** the other server is told with the call (`/fed/v1` call body gains a
   `recording` flag) so its people hear and see the announcement from their own app and phone;
   a server may refuse recorded calls for its people.
