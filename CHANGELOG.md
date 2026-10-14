# Changelog

Changes to the server (self-hosted and Cloudflare), the companion app, the browser phone, the
CLI and the protocols. The firmware has its own [firmware/CHANGELOG.md](firmware/CHANGELOG.md);
hardware releases are tagged `hw-vX.Y` with their files attached.

Server releases are git tags `server-vX.Y.Z`. The version is `version` in the root
`package.json`; a server reports it in `/api/health` and in its federation discovery document
(`software`). Database migrations apply in order and are additive, so updating a server is a
redeploy. Compatibility rules: "Versions and compatibility" in [docs/protocol.md](docs/protocol.md)
(phones and apps) and §9 of [docs/federation-spec.md](docs/federation-spec.md) (servers).

## 0.4.0 (unreleased)

On `main`, not tagged yet.

- **Forms say what to fix.** Every companion form keeps its button enabled and, on submit,
  says next to the field what's wrong in plain words ("Use 2 to 6 digits.", "That's a server.
  Add the name in front: name@server."), checked like the server checks it. No grey example
  values that look filled in; examples are hints. Add a household asks for its time zone. The
  server's own refusals are plain sentences too ("Name can be at most 24 characters." instead of
  zod's wording), and the companion says "Couldn't reach the server" when offline.
- **Space settings.** A Settings tab for every space: its name and time zone can be changed after
  it was made (`PATCH /api/space {name?, timeZone?}`; any guardian of a home, the owner or an
  admin of a team or org; others see the values). Everything on the space's clock follows at
  once: phones get fresh config (clock, quiet status, owner line) and the hub's next quiet-hours
  change, Lounge end of day, party line hours and call backs are scheduled in the new zone. The
  privacy settings moved here from Account.
- **An audit trail in every space.** Homes now log what teams log (and more of it: quiet hours,
  a kid's phone's allow-list, keys, name, voicemail settings and greeting, Lounge settings, the
  space's name and time zone), shown under Settings → Changes. Only a home's guardians, or a
  team's or org's owner and admins, can read it (never members, other spaces or other servers);
  nothing edits or deletes it except the space's history retention. Entries hold who, what, when
  and ids/names/counts, never content: a notice's text is no longer stored, and content or secret
  fields are dropped from every entry. A failed audit write is logged as an error.
- **Public lines on Lounge phones.** A member signed in at a Lounge phone gets the lines on their
  own phone's keys. A Lounge phone with nobody signed in can't call a public line: the call is
  refused before anything is sent and the phone shows `SIGN IN TO CALL` (additive: the note's
  value on `call.state`); house-line keys can't hold a line.
- **Missed call backs on the phones.** A public line's call back that rang and wasn't taken shows
  on the person's own phones as a missed call naming the line (`MISSED CALL BACK` / its name),
  until they clear it (MENU → Voicemail → Clear), call the line, or take its next call back.
  Additive protocol: `config.missed[].callback`, `missed.clear`. Migration 0026 (additive). In
  the data export as `missedCallbacks`. Firmware 0.9.2 shows and clears them.
- **Party line hours**: a room can be open only at set weekly times (the space's time zone,
  windows past midnight, the same rules as quiet hours). Outside them nobody gets in ("Closed.
  Opens Fri 19:00"). At opening the space's apps get `room.opened` (the companion offers to join)
  and phones with the room's key get a `PARTY LINE OPEN` notice with a chime (not a kids' phone
  in its quiet hours); a minute before closing the people in it are warned (`room.idle` with
  `closing`), and at closing it ends for everyone. `PATCH /api/rooms/:id {hours}`; companion:
  Rooms → Hours; browser phone: `CLOSING SOON`. Additive protocol: `room.opened`,
  `room.idle.closing`. Migration 0025.
- **Notices**: a space's guardians (in a team: the owner and admins) post a short notice to its
  phones, all of them or some: one or two lines of 16 characters, an optional 30-second
  recording, an hour unless they choose otherwise (up to a day). Phones show it on the ready
  screen with a chime (none during quiet hours), lifting the handset plays the recording, any key
  dismisses it on that phone; it leaves every phone when it expires or is taken down. Audited
  (without its text); never federated. `/api/notices`; additive protocol: `notice`,
  `notice.cleared`, `notice.dismiss`, device feature `notices`. Companion: Home → Notice to the
  phones. Migration 0024. See [docs/notices.md](docs/notices.md).
- **Call me back** (public lines): a caller waiting in a line's queue can hang up and keep their
  place; when it's their turn the line rings their apps and phones, and answering calls the line
  again in their place. A missed call back gets one more try later or the line's voicemail offer
  (a per-line setting); the place is kept for up to two hours. On by default per line; works
  across servers (federation feature `line-callback`: `call.callback` on the stream,
  `/fed/v1/lines/callback` and `/fed/v1/lines/callback/missed`, the `line` target's `callback`).
  Never for kids' phones or Lounge phones with nobody signed in. Additive protocol: `call.callback`,
  `call.state.queue.callback`, `call.state.callback`, `call.ringing.callback`, device feature
  `line-callback`. Companion: "Call me back" in the call screen, the line's settings; browser
  phone: key 2 while waiting. Migration 0023.
- **Fix:** two people from the same household (or a phone and an app there) can wait in a public
  line on another server or in another household at the same time; the second used to get "busy".
- Companion: a public line's recent callers show who is already blocked, and "Block server" isn't
  offered for the line's own server.

## 0.3.1 (2026-10-13, `server-v0.3.1`)

- **Companion: phone status says what's true.** "My phone" no longer says "No phone yet" when the
  household has phones: it says none of them is set up as yours, and how to make one yours. An
  offline phone's note fits the phone: a virtual phone's page must stay open; a hardware phone
  needs power and Wi-Fi (MENU 7 shows why); a phone that never reported its kind gets both. The
  app no longer says the hardware isn't ready.

## 0.3.0 (2026-10-13, `server-v0.3.0`)

What l1 and the public hub run.

- **Public lines.** A team or organization can publish a ring group at its own address
  (`orders@acme.example`) that anyone on any server may call without knocking first: off by
  default, turned on by an owner or admin after a warning (audited). Callers wait in a queue when
  nobody is free (their place in line, "Leave a voicemail instead", a longest wait and a longest
  line), outside business hours the after-hours action applies, and messages go to the group's
  shared box. Per line: who may call (anyone, people connected to the space, or an allow-list),
  the name and description callers see, queue and voicemail options, its own greeting, and limits
  per caller and per server. Members see each caller's verified address; admins see recent
  callers and can block people and whole servers. Kids' phones can never call a line. A line that
  doesn't take you answers like one that doesn't exist. Additive protocol: `call.line`,
  `call.voicemail`, `call.state.queue`, `call.state.line`, `call.ringing.from.address`,
  `call.ringing.line`, device feature `public-lines`; federation feature `public-lines` (the
  `line` call target, `call.voicemail` on the stream). Companion: Admin → Ring groups → Public
  line, Connections → Call a public line, and the queue in the call screen; browser phone: a line
  on a key, `IN LINE 2` / `1 VOICEMAIL`. Migration 0022.

## 0.2.0 (2026-10-13, `server-v0.2.0`)

Everything since `server-v0.1.0`; this is what l1 and the public hub run. Device protocol and federation stay at version 1;
every change below is additive.

- **Versions and features.** Servers advertise their software, the federation versions they
  speak (`versions`) and optional `features`, and negotiate per peer: a missing feature is
  refused in plain words instead of failing silently, and no common version says which side needs
  an update. Phones and apps get the server's protocol range and features (`config.server`,
  `app.ready.server`); a phone that is too old is told `UPDATE NEEDED`. Unknown fields, messages
  and stream frames are ignored. v1 is frozen by conformance vectors (`tests/conformance/`), and
  CI runs this server against the previous release in both directions. Migration 0020.
- **Phone clock.** `config.now` carries the server's clock, so hardware phones show the time
  without asking a public time server.
- **Voicemail on phones.** Messages and greetings are recorded as 8 kHz WAV; a personal phone can
  fetch, play and mark its owner's voicemail (`voicemail.fetch`, `voicemail.items`,
  `voicemail.heard`, feature `voicemail-play`), counting messages from every space the owner is
  in. Migration 0021.
- **Daily check-in alert** for the labs firmware: a phone that misses its check-in sends
  `checkin.missed`, and the space's guardians get an alert in their voicemail inbox (at most once
  every 12 hours).
- **Browser phone** laid out like the minimal board, its screen drawn the way the firmware draws
  the e-paper; screens, keys, menu and status light follow [docs/phone-ux.md](docs/phone-ux.md).
- Server pages readable without JavaScript, and a `robots.txt`.

## 0.1.0 (`server-v0.1.0`, 2026-09-30)

The first tagged release: the complete software side.

- **Calls and phones.** Wire protocol, the phone's state machine, quiet hours (DST and past
  midnight), default-deny access in both directions. Self-hosted Node server with SQLite, the
  Cloudflare backend (Workers, Durable Objects, D1, R2, TURN), the companion app, and the browser
  phone, installable on any old phone or tablet (`/device/`). Peer-to-peer audio.
- **People.** Invites, passkeys, accounts with addresses (`name@server`), several households per
  account, spaces (home, team, organization), handles reserved 90 days after release, optional
  open sign-up.
- **Phones.** Kids, personal and Lounge modes chosen at pairing; P-256 and Ed25519 device keys;
  a four-word fingerprint; remove = the phone wipes itself.
- **Lounge phones.** QR takeover with a press-the-flashing-key proof, sessions that leave nothing
  behind (idle, end of day or until logout), open to chat, optional house-line keys and "who's
  here", guests from other servers.
- **Connections across servers.** Knock, accept, decline, block; signed server-to-server requests
  (RFC 9421, Ed25519) with pinned keys; calls, voicemail, presence and Lounge guests across
  servers; a call rings a person everywhere they are; key rotation with a 7-day hand-over and an
  operator view of pinned keys.
- **Voicemail everywhere.** Every unanswered call offers voicemail; greetings (standard, your
  recorded name, your own); ring time; transcripts where the server has speech-to-text; a buddy
  timeline of calls and messages with retention per connection, account or space.
- **Rooms and call control.** Party lines and phone rooms with addresses, hold, add a caller and
  merge, blind and attended transfer; a peer-to-peer mesh or a relay (Cloudflare Realtime SFU, or
  LiveKit when self-hosting).
- **Workplace spaces.** Roles, directory, extensions, ring groups, business hours, shared
  voicemail boxes, call log with CSV export, audit trail; opt-in call recording that is always
  announced and never used with kids' phones.
- **The public hub.** Fair-use allowance, Turnstile, per-IP and per-account limits, operator
  view, funding summary, account export and deletion.
- **Tools.** The `npx openloungephone` CLI (`deploy cloudflare`, `selfhost init`, `status`,
  `doctor`, `federation rotate-key`); interop CI between two self-hosted servers and two Workers;
  the normative federation spec, generated from the schemas.
