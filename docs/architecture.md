# Architecture

```
 ┌──────────────┐   WebSocket (protocol v1)   ┌───────────────────────────────┐
 │ Phone        │◀──────────────────────────▶│ Your server (pick one)        │
 │  /device/ app│                              │  • Cloudflare: Worker + DOs,  │
 │  ESP32-S3    │   WebRTC audio (Opus, DTX)   │    D1, R2, TURN               │
 │  (later)     │◀─────── peer to peer ──────▶│  • Self-host: Node + SQLite + │
 └──────────────┘   (TURN relay if needed)     │    coturn (Docker)            │
        ▲                                      └───────────────┬───────────────┘
        │ WebRTC audio                    WebSocket + HTTP ▲   │ signed /fed/v1 HTTP +
        ▼                                                  │   │ server-pair stream
 ┌──────────────┐──────────────────────────────────────────┘   ▼
 │ Companion app│  households, phones, allow-lists,  ┌───────────────────────────┐
 │ (PWA)        │  connections, calls, voicemail     │ Other Open Lounge Phone   │
 └──────────────┘                                    │ servers (and the hub)     │
                                                     └───────────────────────────┘
```

## Layers

| Layer | Package | Runs on |
|---|---|---|
| Wire protocol | `packages/protocol` | everywhere |
| Domain logic (ACL, quiet hours, call/room/device state machines) | `packages/core` | everywhere; mirrored in firmware |
| Storage: plain SQL migrations shared by D1 and SQLite, typed store | `packages/db` | servers |
| HTTP/WS app written against backend interfaces | `packages/server-app` | servers |
| Server-to-server federation (signatures, keys, `/fed/v1` schemas) | `packages/federation` | servers |
| Call and room media: 1:1 calls peer to peer (STUN/TURN); rooms as a peer-to-peer mesh (≤ 4) or through a relay (Cloudflare Realtime SFU, or a self-hosted LiveKit) | `packages/client` (`CallMedia`, `RoomAudio`), `packages/server-app` (`liveRooms.ts`, `sfu.ts`) | clients, servers |
| Entry points | `apps/server-selfhost`, `apps/server-cloudflare` | Node / Workers |
| Clients | `apps/device-web`, `apps/companion` (a Tauri desktop app is planned) | browser |

The backend is pluggable: only the entry point and the implementations of storage (`Sql`), the
live coordinator (sockets and household hubs), the blob store, the transcriber, and the
server-pair streams differ between Cloudflare and self-host.

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

**Buddy timeline.** A connection's page in the companion shows your history with that person
(`GET /api/connections/:id/timeline`): calls both ways from `call_log` (when, how long,
answered or missed) and the voicemails they left you, attached to the missed call they followed,
with transcripts and playback. There is no text chat. Each person's side is their own: retention
is per connection (`PUT /api/connections/:id/retention`), else the account default
(`PUT /api/account/retention`), else forever — 30 days, 1 year or forever. `Store.sweepExpired`
deletes a space's expired rows and the audio blobs; the hub runs it on activity at most every six
hours (never on a timer of its own, so a quiet Durable Object stays asleep), the self-hosted
server once a day, and the timeline and inbox before they're read.

Calling rules don't change: `authorizeInbound` / `authorizeOutbound` still decide every call, and
calls stay inside one household until federated connections (see
[federation.md](federation.md)) add grown-up ↔ grown-up reachability through an accepted
"knock". There is no bridge to the phone network (PSTN), ever.

**Hold, 3-way calls and transfer.** Either party can put an answered call on hold
(`call.hold`): the holder's audio stops and the other side hears a soft tone that its own phone
or app plays (prompt `hold.tone`; nothing is sent). While holding one call a person may place one
more — a *consult* call, never a third (`controlCheck` in `packages/core`). Then:
- **Merge** (`call.merge`): both calls become a room of kind `call`, hosted by the person who
  merged. The calls end with `call.state {merged: {roomId}}` and every client keeps the old
  call's audio playing until the room's audio is connected (make before break), so nobody hears
  a gap. Someone in another household or on another server stays reached through their own
  server: the call's id carries on as their *room leg*.
- **Transfer**, blind (`call.transfer {to}`): the person being transferred rings the target *as
  themselves*, with their own permissions (a kids' phone reaches only its allow-list); attended
  (`call.transfer {toCall}`): the held person and the consult person are connected directly and
  the transferring person leaves both calls. Clients follow with `call.state {transfer: {callId,
  ringing, offerer}}`. Someone in another household or on another server can be transferred
  only inside a team or org space, to its own members, phones, ring groups and extensions (their
  server follows the `transfer` notice; a kids' phone's never does); see
  [workplace.md](workplace.md).
- A merge or an attended transfer never puts a **kids' phone** together with someone who isn't
  on its allow-list (`mayConnect`).
- **On the phone:** MENU → 1 *Add caller* (holds the call) → a speed-dial key → MENU → 1 *Merge*
  (or 2 *Transfer*). The phone plays prompt ids (`CallPrompt` in the protocol), e.g. "Choose who
  to add, then press menu to merge" and "You're all together now"; the strip shows `CALLER ON
  HOLD`, `ON HOLD`, `MENU: MERGE`. The companion has Hold, Add caller, Merge, Transfer and
  "Connect them & leave".

**Team and org spaces (workplace phone system).** Owner/admin/member roles, a searchable
directory, extensions for members, phones, rooms and ring groups (`call.extension`; phones:
MENU → Dial ext), ring groups (simultaneous, sequential, round robin; a hub-side `hunt` state
steps through members on the room's timer), business hours with an after-hours action, shared
voicemail boxes (`voicemails.group_id`, "heard by"), the space's call log with CSV export and an
audit trail (`audit_log`) — migration `0017_workplace.sql`; see [workplace.md](workplace.md).

**Recording.** Off unless a space turns it on; never with kids' phones. When a call goes live the
space's hub announces `call.state.recording` to every party (other servers' people through their
server) and only then hands the recording side's own client an upload ticket; rooms carry
`room.state.recording`, the host's client recording. Recordings are uploaded like voicemail
(`/api/rec/upload`), linked to the call log, and expire with history. See
[security-model.md](security-model.md).

**Rooms.** Three kinds, all live in the owning space's hub (`LiveRooms`):
- **Party lines**: a space's always-open rooms (guardians make them). Members drop in and out and
  see who's in (`rooms.changed`, `GET /api/rooms`).
- **Phone rooms**: a name with an address, e.g. `standup@host` (room handles share the namespace
  of people's handles), made by any member, who hosts it. Open to the space, or also to its
  owner's connections. Dialable from the companion (by id, or by address on any server) and from
  a phone's speed-dial key once a guardian puts the room on the phone's allow-list
  (`PUT /api/devices/:id/rooms/:roomId`; migration `0016_rooms.sql`).
- **3-way calls**: made by merging; nobody dials in.

Access is default deny (`roomAccess`): the space's members; for a phone room open to
connections, anyone with an active connection to its owner (checked by the room's own server);
kids' phones only rooms of their own space that are on their allow-list. Then the lock and the
size. Hosts (the owner, a home's guardians, whoever merged a 3-way call) can mute people (they
may unmute themselves), remove them and lock the room. Someone on another server joins by
address: their server sends a signed `POST /fed/v1/rooms/join`, the room's server decides, and
everything after that travels as `room.signal` on the server-pair stream (between households
here: hub to hub). A room's audio always goes through its owner's server.

**Room media.** 1:1 calls stay peer to peer. Rooms use the server's relay when it has one
(`room.state.media`):
- **no relay** (the default): a peer-to-peer mesh of at most 4 people, end-to-end encrypted
  (`rtc.*` with `peer`, relayed by the room's hub);
- **Cloudflare Realtime SFU** (`SFU_APP_ID`/`SFU_APP_SECRET`): the server holds the app secret
  and drives each participant's single peer connection over `room.media`. It pushes their
  microphone, pulls the others into slots, and when the speakers change asks the client to stop
  a slot and offer again (a negotiated close, so the SFU reuses the m-line and the SDP stays
  small — `tracks/update` only re-targets simulcast tracks); pulls retry until the publisher is
  sending;
- **LiveKit** (self-host, `LIVEKIT_*`): clients connect to it with a join token the server signs,
  and listen to whom `room.state.forward` lists.

Relayed rooms are **encrypted in transit but not end to end**: the relay could hear them.
End-to-end room encryption (SFrame) is planned; the apps say so. Cost controls: Opus DTX
everywhere; in rooms of more than 4 each person gets only the 3 most active speakers
(`forwardFor`, from clients' own voice activity, `room.talk`), and muted people aren't forwarded
at all; someone silent and idle for 10 minutes is warned (`room.idle`) and dropped a minute
later unless they speak or answer (`room.here`; on the hub's one alarm, no timers); room minutes
are metered for fair use when someone leaves — each person by their own server, people from
other servers against the room's owner.

**Pairing.** An unpaired phone generates an Ed25519 keypair, sends `pair.begin`, shows the
returned 6-digit code on its e-ink status strip, and reads it aloud when the handset is lifted. A guardian enters it in the companion app; the server binds the public key
to the household and sends `pair.done`. Every later connection is a signed `auth.challenge`, so
no shared secret is ever stored on the device. The claim picks the phone's **mode** — kids,
personal (always its owner) or Lounge — and removing a phone makes it **wipe itself** (`wipe`,
now or when it reconnects with the removed key); see [device-lifecycle.md](device-lifecycle.md).

**Outbound call.** Handset up → button → server resolves the button to a contact and calls
`authorizeOutbound` (default-deny, quiet hours) → a call room rings the contact's companion app →
both sides negotiate media via the configured provider → handset down ends the room.

**Inbound call.** A contact dials the phone → `authorizeInbound`. Outside quiet hours the phone
rings. During quiet hours the call goes straight to voicemail (below). The phone never rings.

**Voicemail everywhere.** Any call that was allowed but isn't answered goes to voicemail: no
answer within the callee's ring time (per person or phone, default 25 s, `voicemail_prefs`),
declined, busy, quiet hours, unavailable, or offline (`goesToVoicemail` in `packages/core`). The
caller's hub then ends the call with `call.state {state: "ended", voicemail: {ticket, name,
maxMs, prompts}}` — to the caller only, and never across servers. The **ticket** (single use,
10 minutes, `voicemail_tickets`, `vmTickets.ts`) stands for the dial that was already
authorized, so no new permission check is invented: whoever couldn't have called can't leave a
message, and a kid's allow-list entry is re-checked when the message arrives. It is also the
only credential needed, so a phone (which has no HTTP session) can use it:
`GET /api/vm/greeting?ticket=` (the greeting audio, or 204 for the spoken default) and
`POST /api/vm/message?ticket=` (the message, ≤ 2 minutes). The message lands in the right inbox
(`voicemails.device_id` for a kids' phone → its guardians and "missed" on the phone;
`voicemails.to_user` for a person → their own inbox, across all their spaces, never a shared
Lounge phone); it's stored in the blob store, transcribed (Workers AI Whisper or an
OpenAI-compatible endpoint), linked to the callee's call-log row (the buddy timeline), and
announced (`voicemail.new` to guardians, `voicemail.inbox` to the person). For someone on
another server (or another household here) the ticket names the connection: the caller's server
fetches their greeting with a signed `POST /fed/v1/greeting` and delivers the message with
`POST /fed/v1/voicemail`; the other server checks the connection (and, for a phone, its
allow-list) itself.

**Greetings.** Three kinds per person and per kids' phone: the spoken default ("<Name> can't take
your call. Leave a message after the tone."), a recorded **name** (≤ 3 s) inside that sentence,
or a **custom** greeting (≤ 30 s), stored as blobs. The companion records, plays back and resets
them; a phone records its own from MENU → Voicemail (`greeting.begin` → `greeting.ticket` →
`POST /api/vm/greeting?ticket=`), which guardians can switch off. Callers play the greeting from
`greetingScript` (`packages/core`): the browser uses speech synthesis for the spoken parts;
firmware plays pre-recorded **prompt ids** (`VoicemailPrompt` in the protocol). The browser
flow (fetch, play, tone, record, upload) is `LeaveMessage` in `packages/client`, shared by the
companion and the browser phone.

**Presence rate limit.** Presence shared with connections is limited to 5 updates per account
per 10 s. A change inside a full window isn't dropped: the latest state waits in
`presence_pending` and the hub sends it when the window opens, on its own `wakeAt` alarm (the
Durable Object alarm on Cloudflare) — no timers.

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
app, the space's session length (`households.lounge_session`: idle minutes while hung up,
`lounge_idle_minutes` default 10; the end of the day, `lounge_day_end`; or only at logout),
a new takeover, or a disconnect that lasts over 60 s (a reconnect within 60 s resumes the session;
the deadline and the end of day use the hub's single `wakeAt` alarm, shared with quiet hours); the phone gets `lounge.ended` and forgets everything. The server
keeps only a `lounge_sessions` row (who, where, when) for guardians. "Open to chat"
(`lounge.chat`, a MENU item) and the person's location travel in `member.status.lounge`. While
nobody is signed in the phone is dead, unless its space turned on house-line keys or "who's
here" (`config.houseLine`, `config.here`).

## Phases beyond software

The phone has **no main screen**: keycapped keys with per-key LEDs, a small e-ink status strip,
handset audio, a ringer speaker, and radios and sensors. Hardware details and part choices live in [hardware/DESIGN.md](../hardware/DESIGN.md).

1. **Firmware** — ESP32-S3 (ESP-IDF, FreeRTOS, esp-webrtc) on off-the-shelf dev boards with an
   audio codec, a USB-C (UAC) handset, and MX-style key switches with per-key LEDs, implementing
   the same protocol and the `deviceStep` state machine from `packages/core`.
2. **Custom PCB** — one board, one BOM (owner, 2026-09-28) in a compact 3D-printed base: an
   off-the-shelf G-style USB-C handset on a raised hook rest, USB-C power with an optional
   battery, 12 hot-swap keys with per-key LEDs, the e-ink strip, a hall-effect hook sensor, a light
   sensor, and NFC for provisioning and Lounge takeover. Schematic done; board placed, routing
   next.
3. **Lounge hardware** — the Lounge software works today with the on-screen QR code; the board
   adds an NFC tap. mmWave presence (a presence-based logout) is deferred to a possible future
   board.

Planned software phases (see the status table in the [README](../README.md)): interop tests in
CI and a versioned federation spec (P5). Call recording (opt-in per space, always announced) is
done; see [security-model.md](security-model.md). Rooms, 3-way calls, hold and
transfer (P3.5) and the workplace phone system for team and org spaces (P6: directory,
extensions, ring groups, business hours, shared voicemail, roles, call log and audit) are done. There is no text chat and no phone-network bridge.
