# Changelog

Changes to the server (self-hosted and Cloudflare), the companion app, the browser phone, the
CLI and the protocols. The firmware has its own [firmware/CHANGELOG.md](firmware/CHANGELOG.md);
hardware releases are tagged `hw-vX.Y` with their files attached.

Server releases are git tags `server-vX.Y.Z`. The version is `version` in the root
`package.json`; a server reports it in `/api/health` and in its federation discovery document
(`software`). Database migrations apply in order and are additive, so updating a server is a
redeploy. Compatibility rules: "Versions and compatibility" in [docs/protocol.md](docs/protocol.md)
(phones and apps) and §9 of [docs/federation-spec.md](docs/federation-spec.md) (servers).

## Unreleased

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
