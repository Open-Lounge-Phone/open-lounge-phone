# Security model and trust

Status: the hardware side describes the **minimal board**; the software side is **built** (the
four-word fingerprint, the device page, remove and wipe, retention defaults and transcription per
space, recovery codes and sessions, and call recording as designed below). Items marked *(planned)* are not built yet.

## Your keys, your server

Nothing depends on the project. Every key belongs to whoever runs that part:

| Key | Where it is made and kept | Who holds it |
|---|---|---|
| **Device key** (P-256) | made on the phone at first boot; never leaves it (encrypted storage in release builds) | the phone; servers know only its public half |
| **Server federation key** (Ed25519) | made on each server when it is deployed; published at `/.well-known/openloungephone` | whoever runs that server |
| **Update key** (RSA-3072, optional) | made with `firmware/tools/release.sh keygen` on the builder's machine (gitignored) | the builder, if they turn updates on |
| **Storage key** (eFuse HMAC, release builds) | burned into each chip at its first boot; software can use it, never read it | the phone |
| **TURN / SFU / Turnstile keys** (optional) | the deployer's own Cloudflare account, or their own coturn/LiveKit | the deployer |

- **A phone built from source connects to no server** until someone chooses one on its setup
  page: their own, or the public hub (`hub.openloungephone.app`) to try it. The choice can be
  changed any time (MENU → 4, or the console); a new server means pairing again.
- **A phone built from source checks for no updates.** It embeds no update key and no update
  URL. Builders who want updates make their own key and run their own channel.
- **Official firmware releases** (`fw-v*`) are the one place the project's key is used: they
  embed the project's public key and its `fw-stable` channel, so a phone flashed with an official
  binary takes the project's updates. Choosing that binary is the opt-in. The project's private
  release key is kept offline by the maintainer, never in the repo.
- **Secure Boot** (when a builder turns it on) burns the digest of **their** update key.
- **Servers** run on the deployer's account or machine (Cloudflare or self-hosted). Federation has
  no central directory: any server talks to any other, and the hub is one server among them.

## What the hardware does and doesn't guarantee

**The board has no microphone of its own.** The phone's only microphone is the one in the
handset, on the 3.5 mm jack (no base microphone, no speakerphone). So the hardware guarantee is
simple: **unplug the handset and there is no microphone connected at all.** With the handset
plugged in, the software mutes its mic while it is hung up and captures audio only in a call.
The minimal board (`hardware/DESIGN.md`) is deliberately simple: an ESP32-S3, a codec, keys, a
hook switch, a display module, a piezo ringer and one status LED. That means:

- **No hardware mic cut-off.** There is **no mute switch** and there are **no mic lights wired to
  the mic's power**: the handset mic is biased whenever the handset is plugged in and the board
  is powered, and the **firmware** decides when audio is captured and sent (firmware 0.2: only
  while a call's encrypted media is connected, or during the explicit `audio loop` bring-up test on
  the serial console; otherwise the codec's ADC is muted and I2S receive is off). A compromised
  firmware could listen through a plugged-in handset. The protections are therefore the
  firmware ones below (signed, reproducible, debug-locked) and unplugging the handset.
- **The hook is read by firmware** (an MX switch under the hook rest); nothing in hardware
  disconnects the earpiece or the mic on hook.
- **No separate recording light.** The one status LED and the display show recording (firmware
  drives them from the call's recording state, see below), which is a firmware signal, not a
  hardware one.
- **No camera, no radar, no NFC, no light sensor.** Nothing on the board can see anyone.
- **Mains/USB-powered like a landline**: no battery by design. It is not a mobile device and
  does not go anywhere with you.
- **Open hardware** (CERN-OHL-S): the schematic, layout and parts list are public.

## Firmware guarantees

What the firmware does today (firmware/README.md has the details) and what is still planned:

- **Signed updates** (**built**, firmware 0.4; off in source builds from 0.6): a phone installs an
  update only from a manifest signed by the update key built into it (official releases: the
  project's release key, RSA-3072, private half kept offline by the maintainer; your builds: yours),
  for its own board, newer than what it runs, with the image's SHA-256 checked while it is written.
  Release builds also check the image's own Secure Boot V2 signature before switching to it. Updates
  install only while the phone is hung up and idle (overnight by default, or MENU → 9), and a new
  image that crashes or can't reach the server is rolled back to the previous one. Phones read a
  fixed firmware channel, never GitHub's "latest release".
- **Downgrades are refused** (only a newer version installs). *Planned:* eFuse anti-rollback
  (secure version), so even a signed old image can't be installed by someone with the board.
- *Planned for production phones:* **hardware Secure Boot V2 and flash encryption** (eFuses,
  one-time): only signed firmware boots and a stolen phone's flash is unreadable. Today the image
  signature protects against the network, not against someone who reflashes the board over USB.
- **Device key** generated on the phone and never exported. Removing the phone in the app makes it
  useless: the phone erases its whole storage partition (not just "marks deleted").
- **Encrypted storage** (**built**, firmware 0.5, release builds): the device key, its id and the
  Wi-Fi password are encrypted at rest (ESP-IDF's NVS encryption with keys derived from an eFuse
  HMAC key that software can use but never read; burned once, on the first boot). Reading the flash
  chip shows only ciphertext. Someone who can run their own firmware on the chip could still use
  the HMAC key; hardware Secure Boot V2 (planned) closes that.
- *Planned:* **debug ports locked** in production; hobby builds get a clearly marked unlocked
  option.
- *Planned:* **reproducible builds with published fingerprints**, shown on the phone.

## Accounts and sign-in

Accounts have no password, email or phone number. People sign in with **passkeys** (WebAuthn:
built-in, a phone by QR code, a security key or a password manager); the server keeps only each
passkey's public key.

- **Recovery code.** Every account gets one when it is made (the setup link, open sign-up, or the
  first time an invited person joins), shown once with Copy and Download and a re-type check.
  Accounts without one see a lasting reminder until they make one (Account → Recovery code). It
  is 28 base32 characters (140 bits) in groups of four; the server keeps only a hash bound to the
  account, compares in constant time, and never logs, audits or exports it. Making a new one stops
  the old one working.
- **Recovering.** "Lost your passkey?" (or `/#recover`): your handle and the code. A wrong handle
  and a wrong code get the same answer; tries are limited per handle from one network (5 an hour,
  so a stranger guessing elsewhere can't lock the owner out), per IP address (20 an hour) and per
  handle from anywhere (100 a day). The session it gives lasts 30 minutes and may only add a
  passkey (no API, no app socket). The code stays valid until that new passkey is saved, so a
  cancelled passkey prompt can start again; saving the passkey uses the code up first, so of two
  recoveries with the same code only one gets a passkey. Then the person gets a new code and is offered "Sign out everywhere else" (on by default). `account.recovered`
  goes into the audit trail of every space they're in, and their other open apps are told
  (`account.notice`). A suspended account can't recover. There is no email recovery and no
  operator recovery.
- **Sign-in links** (a guardian's or admin's "Sign-in link" for someone in their space) work
  only for someone whose **only** space on this server is that one: a link could otherwise open
  spaces the guardian doesn't manage. This is checked when the link is made and when it is used.
  Nobody but the owner makes one for the owner; in teams only the owner makes them for admins. A
  new link cancels that person's older ones. Making and using one are audited, using one tells the
  person's other apps, and guardians see and can cancel the links not used yet.
- **Sessions** (a bearer token in the app; the server keeps only its hash) **slide**: each day a
  session is used, it ends 90 days after that use. A session no passkey backs (an invite or a
  sign-in link on a device that made none) does not slide: it ends 90 days after it started, and
  the app says on which date. Account → Where you're signed in lists each session (browser and
  system, when it signed in and how, last used, this device) with Sign out on each and "Sign out
  everywhere else". Removing a passkey signs nobody out by itself (the app offers to sign out
  everywhere else). Signing out, a suspension, leaving or being removed from a space, and account
  deletion close the person's open app connections at once. Expired sessions and invites are
  purged by the regular history sweep.
- **The last passkey** can be removed only when the account has a recovery code.
- **Owners.** Every space has an owner: whoever made it, until they hand it on (to another
  guardian in a home, or an admin in a team or org). Nobody else can remove the owner or make a
  sign-in link for them, and only the owner changes roles. An owner leaves, or deletes their
  account, only after handing on each space other people are in; a space they're alone in is
  deleted with it.
- **Operators** (the server-wide admin view) are named by **account id** (`OPERATORS=acc_…`),
  never by handle, so a renamed, released or re-registered handle never carries operator rights.
  `deploy.ts --operator <handle>` looks the handle up once, at deploy time; a self-hosted server
  logs the id to use when `OPERATORS` holds a handle.

## Network and service

- **Encrypted calls:** 1:1 calls use WebRTC (DTLS-SRTP), peer to peer. The TURN relay only forwards
  encrypted packets. The server and relay never hear 1:1 audio. The hardware phone does the same
  (**built**, firmware 0.2: Espressif's `esp_peer`, a fresh ECDSA DTLS certificate per boot, G.711
  audio); its TURN credentials, like the browsers', are short-lived and never logged. Group rooms
  have no media on the hardware phone yet.
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
- **Public lines are the one exception to knock-first** ([workplace.md](workplace.md#public-lines)):
  a team or organization can publish a ring group at its own address that anyone may call without
  connecting. Why that is safe enough: it is off until an owner or admin turns it on and confirms
  a warning (audited); it reaches only the people the space put on that line, never a person's
  own address or phone; every caller is identified by an address their server signs for, shown
  to whoever answers; the space can block people and whole servers, and narrow the line to people
  connected to it or to an allow-list; the operator's blocklist and per-caller and per-server
  limits apply; a line that doesn't take you looks exactly like one that doesn't exist; and kids'
  phones can never call one (their own server refuses, and the line's server refuses calls
  flagged as from a kids' phone). A line may ring someone only when they asked it to call them
  back: their own server keeps that request (for that line and that waiting call, for at most
  about two hours) and rings them only for a call back that matches it; anything else is
  ignored.
- **Federation:** signed server-to-server requests (RFC 9421), server-key pinning, blocklists and
  rate limits.
- **Lounge:** signing in needs a physical key press (proximity proof). Nothing stays on the phone,
  and the server keeps only who, where and when.
- **Data minimisation:** retention settings with automatic expiry, per space and per person (see
  below). Transcription can be switched off per space; on Cloudflare it runs on Workers AI.
- **Hub operators can see metadata** (who called whom, and when), never call audio. For full
  assurance, run your own server.

- **Wi-Fi setup network** (**built**, firmware 0.3): WPA2 with a fresh random 8-digit password
  shown only on the phone's display, so joining it needs someone at the phone. The setup page
  answers only on that network (not on the home LAN), and only while setup is open; the Wi-Fi
  password is stored like the device key (NVS, encrypted in release builds)
  and never logged.

## Trust signals people can see

1. **Owner and mode:** the strip always shows them, e.g. "Kids · Smith home", "Lounge · free" or
   "Signed in: Jesse".
2. **Recording is visible and announced:** off unless a space enables it, always announced,
   and shown on the phone's status LED and display (`REC`). These are firmware-driven signals;
   the minimal board has no hardware mute switch or mic lights (see above).
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

## Audit trail

Every space (households, teams and organizations) keeps a list of who changed what
(`GET /api/space/audit`; the companion's Settings → Changes).

- **What's in it:** changes made by the people who run the space: phones added, removed and
  renamed, a phone's allow-list, keys, voicemail settings and greeting (except changes a person
  makes to their own phone), quiet hours, invites and removed people, roles, privacy and
  recording settings, notices posted and taken down, Lounge settings, extensions, ring groups,
  hours, public lines, and the space's name and time zone.
- **What it never holds:** what anyone said or wrote — no notice text or audio, no voicemail,
  transcript or recording, no passkey, session or token, no IP address. An entry is who (their
  account and name in the space), what (the action), when, and the ids, names and counts needed to
  understand it (a time zone change keeps the old and new zone). The server drops content and
  secret fields from every entry as a backstop, and tests check a notice's text never reaches
  the stored row.
- **Who reads it:** a home's guardians, or a team's or organization's owner and admins. Never its
  members or contacts, never another space, and never another server: no federation route
  exposes it.
- **Append-only:** no route edits or deletes an entry. Entries go only with the space's history
  retention (above), by the same sweep, and when the space itself is deleted.
- **A failed write** doesn't stop the change; it is logged as an error for the operator to see.

The server-wide operator trail (key rotation, blocked servers, suspensions) is separate and only
for the server's operators ([federation.md](federation.md)).

## Recording (built)

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
   their status LED as a **recording light** and show `REC` (firmware drives both from the same
   field). It
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

## Add-ons

An add-on ([add-ons.md](add-ons.md)) is a service someone links to their own account, such as an
AI companion. It hears what's said to it, so the rules are strict and the defaults closed.

1. **Off unless the server's operator turns it on** (`ADDONS=on`; Cloudflare `--addons`). Off
   means no linking, linked add-ons can't connect (they're refused before the challenge) or be
   called, and the server doesn't advertise the `addons` federation feature, so other servers
   never offer it add-on calls.
2. **Its own key.** It links like a phone pairs: it shows a 6-digit code, its owner enters it in
   the companion, and its Ed25519 public key is stored. Every connection answers a signed
   challenge; no person's session token is ever given to it. A phone's code can't link an add-on
   and an add-on's code can't pair as a phone. Removing it deletes the link at once, closes its
   socket and tells it to forget the link (also when it next connects, after proving its key).
   Its owner leaving the space it was linked in deletes the link too: nobody can call it from
   then on, and it's told the next time it calls out or connects.
3. **Default deny, both ways.** Only its owner, and the owner's active connections that the owner
   put on its list, may call it or be called by it — on this server and on others (the callee's
   server checks the connection and the list). Nothing else reaches it: no knocks (an address
   with `+` is never a person's), no directory, no public line, no ring group. Every refusal
   answers `unavailable`, the same as for an address that doesn't exist. Calls with an add-on
   can't be merged or transferred, and keys pressed in a call reach only an add-on.
4. **Kids' phones never.** An add-on's address can't be put on a kids' phone's key, a kids' phone
   that dials one anyway is refused, a call through a kids' phone (another server's `viaPhone`)
   never reaches one, and an add-on calls people only (never a phone of a space).
5. **It knows who it's talking to, and people know it's an add-on.** Every call tells it the
   caller's verified address and name; calls from it carry its address and an add-on label in
   the apps and on phones (`SEAT · ADD-ON`). There is no spoken warning: people link and allow
   add-ons knowingly.
6. **Accountable.** Its call minutes count against its owner's fair-use allowance; linking,
   changes to who may talk to it and removing it are in the space's audit trail (names and
   counts, never content). What an add-on does with what it hears is up to its owner and its
   maker, outside this server.
