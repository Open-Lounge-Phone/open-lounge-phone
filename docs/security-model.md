# Security model and trust

Status: 2026-09-28 design; the software side is **built** (the four-word fingerprint, the device
page, remove and wipe, retention defaults and transcription per space, and — batch C2 — call
recording as designed below). Items marked *(planned)* are not built yet.

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
- **Rooms** (built): without a relay a room is a peer-to-peer mesh of up to 4 people, end-to-end
  encrypted like a 1:1 call. Through a relay (the Cloudflare Realtime SFU, or LiveKit when
  self-hosting) a room is **encrypted in transit but not end to end**: the relay could access the
  audio until end-to-end room encryption (SFrame) is added (planned). The apps say which one a
  room is. A 3-way call made by merging follows the same rule.
- **Rooms are default deny** like calls: a space's members, a phone room's owner's connections if
  it's open to them, and kids' phones only rooms of their own space on their allow-list; merging
  or transferring never puts a kids' phone with someone off its list. Hosts can remove people and
  lock a room.
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

## Recording (built in batch C2)

1. **Off unless a space turns it on** (`PUT /api/space/recording`, guardians or admins; audited).
   Never in a home with kids' phones — a home with one can't turn it on, and a home that records
   can't add one — and never on a call with a kids' phone, here or on another server (its calls
   through a guardian's connection are marked, and so is a call we place to one). It's a property
   of the recording side's space: a person can't silently record someone else's call.
2. **Always announced to everyone on the call**, before anything is recorded: when the call
   becomes live, the space's hub sends `call.state {recording: {by}}` to every party — its own
   people directly, people in other households or on other servers through their own server,
   which passes it on without a ticket — and only then gives the recording side's client its
   upload ticket (`recording.ticket`, in the same notice). Every app and phone says "This call is
   recorded." (prompt `call.recorded`), the apps show a red **Recording** mark, and phones light
   their **recording light** and show `REC` (firmware drives the light from the same field). It
   stays on until the call ends. Rooms carry the same `room.state.recording` for everyone. A party
   who doesn't accept hangs up; there is no hidden mode. Tests prove the order (every party is told
   before the ticket goes out) and are mutation-checked.
3. **Where it is made:** 1:1 calls are peer to peer and the server never hears them, so the
   recording is made by the recording side's own client — the companion or the browser phone
   (firmware can't record yet: on a hardware phone the call is announced but only recorded if
   another app on that side can) — mixing what it sends and hears, and uploaded with its ticket
   (`POST /api/rec/upload?ticket=`, single use, ≤ 2 hours). **Rooms** are recorded the same way,
   by the host's client (else another participant of the room's space who can record; when they
   leave the next one takes over with a new part). The Cloudflare Realtime SFU can't record by
   itself: its only way out is the WebSocket adapter (beta), which streams each participant's
   track as raw 48 kHz PCM to an endpoint of ours — recording at the SFU would mean mixing and
   encoding those streams on the server, with no Opus encoder in Workers. The host's client
   already hears the mix, so it records it (with a relay it hears the top three speakers, which
   is what the recording holds).
4. **Where it lands:** a blob plus a `recordings` row linked to the call's call-log rows
   (`call_log.recording_id`), shown in the buddy timeline and in the space's call log (admins,
   also in the CSV export), transcribed only if the space transcribes, in the account export,
   and expiring with the history retention of whoever recorded it. Who may play it: the people
   on the call, and the space's guardians or admins.
5. **Across servers:** a call placed from a recording space says so (`/fed/v1/calls` body
   `recording: true`), so the other server can refuse it before it rings; a server that refuses
   recorded calls (`REFUSE_RECORDED_CALLS=1`) also ends a call — or takes its person out of a
   room — as soon as the other side announces a recording, and tells its person why.
