# Changelog

Changes to the server (self-hosted and Cloudflare), the companion app, the browser phone, the
CLI and the protocols. The firmware has its own [firmware/CHANGELOG.md](firmware/CHANGELOG.md);
hardware releases are tagged `hw-vX.Y` with their files attached.

Server releases are git tags `server-vX.Y.Z`. The version is `version` in the root
`package.json`; a server reports it in `/api/health` and in its federation discovery document
(`software`). Database migrations apply in order and are additive, so updating a server is a
redeploy. Compatibility rules: "Versions and compatibility" in [docs/protocol.md](docs/protocol.md)
(phones and apps) and §9 of [docs/federation-spec.md](docs/federation-spec.md) (servers).

## 0.9.0 (unreleased)

On `main`, not tagged yet.

- **Everything that exists shows in the app** (an audit of what the server keeps against what the
  app lets people see, act on and remove):
  - **Operator → This server**: every setting that isn't a secret, in plain words with what it
    means: version, sign-up and its bot check, add-ons, the fair-use allowance, TURN and the
    rooms' relay, transcripts, recording, public address, federation (key fingerprint, features
    offered), funding and Sponsor, operators, proxy trust and changed limits. Secrets show only
    as set up or not. `GET /api/admin/server` (operators only); how to change each:
    [server settings](docs/site/how-to/server-settings.md). The Operator view also lists
    **suspended** and **fair-use exempt** accounts with their undo (`/admin/overview`:
    `suspended`, `exempt`, additive).
  - **Lounge phones** get **Manage** for guardians on Home (rename, remove and wipe); Home puts
    every phone in exactly one list (mine, the household's, other people's own, Lounge).
  - **Call recordings** are listed in the Voicemail tab (yours; guardians and admins: the
    space's) with play, transcript and **Delete** for whoever may (`GET /recordings`:
    `canDelete`, additive). Before, a home's recorded calls between its own people showed
    nowhere, and no recording could be deleted from the app.
  - **Connections** say which of your phones each one can call (`yourPhones`, additive).
  - **Show older** on the lists that came one page at a time: the operator audit trail, a
    space's Changes, the workplace call log.
  - **Your data** (account export) lists your add-ons with their shares and holders, and the
    add-on shares you hold (`addons`, `addonSharesHeld`; additive, format version 1).
  - Workplace: searching the directory no longer hides people from the admin's extension list
    and ring-group pickers.
- **Someone's own phones go with them**: leaving a space, being removed from it or deleting the
  account now removes and wipes the person's own phones there. Before, such a phone stayed as
  an ownerless household phone in kids' mode (even in a team), out of every list of own phones.

## 0.8.0 (2026-10-16, `server-v0.8.0`)

- **Speed-dial pages**: more than ten people on a phone's keys, in pages of ten (up to 10 pages,
  100 keys; `limits.ts` `keyPages`, a host may allow fewer). The app's key editor shows Page 1,
  Page 2… with **Add page** and **Move someone to another key**; on the phone, BACK with the
  handset up turns the page (docs/phone-ux.md "Speed-dial pages"). Keys are stored as
  `(page - 1) * 10 + slot` (migration 0033 widens the four key tables to 0-99). Protocol
  (additive): `config.pages` and `button.page`, sent only to phones that list `key-pages`
  (device feature `key-pages`); older phones get page 1 as before. Every key on every page
  follows the same allow-list, quiet hours and add-on rules; a Lounge phone pages the
  signed-in person's desk-phone keys. A config that would pass 16 KiB drops its last pages.

- **Add-ons are treated as untrusted** ([docs/security-model.md](docs/security-model.md#add-ons),
  threat by threat, each with a test that fails without its guard). An add-on may send only an
  explicit allow-list of messages (everything else, including message types added later, is an
  `error` with no effect) and is closed after 600 messages a minute. Limits (`limits.ts`): one
  call out at a time, 10 an hour, 6 a day to any one person (so it can't ring all its holders
  like a broadcast); 30 calls an hour from one person to one add-on; share lists 60 and
  connections 120 an hour; at most 10 calls at once; calls end after 4 hours. TURN credentials
  for add-on calls expire with that and are revoked at the end on Cloudflare. Words it chooses
  (share labels, its summary, a refusal, its `fw`) must be plain text (no control or
  right-to-left characters). Its owner leaving the space, the space or account going, or a
  suspension cuts it off at once, live calls included (a suspended owner's add-on can't
  connect). The holder's own server now rings someone for another server's add-on only within a
  share it was told they hold, with the label it was told.
- **Add-ons say what they do**: `addon.about` (additive; device feature `addon-about`) with a
  summary, what it does with what it hears (`nothing` one-way / `live` / `keeps`), whether it
  transcribes, takes calls, calls people, offers shares, takes keys, and how many calls at once
  (`lines`). The server enforces the parts it can; the app shows all of it as the add-on's own
  words. Add-ons that never say keep the old rules. Migration 0032 (`addons.about`,
  `addon_mutes`, `addon_contacts`).
- **An Add-ons tab** in the companion (out of Settings): each add-on's page says what it does
  and has Call, **Add to contacts** (shown on Home) and **Put on a key** (your own phone and its
  first free key chosen; right after linking it's ready, so link → talking from a phone is 8
  steps instead of 14); each share has the same plus **Give to…**, which says what the add-on
  learns about the person before they get it. **Ask it for a new share…** replaces "New shared
  project with…". Connections points at the tab.
- **Holders control add-ons that call them**: **Stop its calls** (enforced by their own server;
  they can still call it) and **Give it back** (`PUT /api/addons/muted`, `POST /api/addons/leave`;
  across servers the federation feature `addon-leave`, `POST /fed/v1/addon-shares/leave`).
- **Reaching an add-on**: its owner may call within any of its shares (`grantId` `owner`);
  `PUT /api/devices/:id/lines` takes `key`; `config.buttons[].addon` lets phones show a key that
  calls an add-on as one; `/api/addons/contacts`.
- **Phones always mark an add-on** (browser phone and firmware strip): a share's label keeps
  `ADD-ON CALLING` below it; in a call and while waiting a long name is shortened, never shown
  alone.
- The Python bridge is 0.3.0: `set_about(...)`, several calls at once, and `examples/radio.py`
  (one-way, several listeners). A call that ends while `call.send()` waits for room (the far
  end stopped taking audio) no longer leaves it, and whatever awaits it, hanging forever.
- The app's badges use the accent's text colour (too little contrast before).

## 0.7.0 (2026-10-15, `server-v0.7.0`)

Phones: firmware 0.9.4 ([firmware/CHANGELOG.md](firmware/CHANGELOG.md))
and the browser phone show what's new here; [docs/phone-ux.md](docs/phone-ux.md) has every screen.

- **Mute everywhere**: MENU 3 in a call on the phones (the browser phone disables the mic track;
  the hardware phone switches the codec's mic off), `MUTED` on the screen and a slow double blink
  on the light; the call screen keeps one digit per action (1 hold, 2 transfer, 3 mute, 9 volume;
  rooms move to 3). The app: **M** toggles Mute.
- **Mic check and audio choices in the app**: a live microphone level and a plain warning when it
  sends nothing for four seconds while you're not muted; pick the microphone and speaker (where
  the browser can) and the other person's volume, remembered on the device.
- **Reconnecting, not silence**: when a call's connection drops, apps and phones say
  `Reconnecting…` / `RECONNECTING` while the side that offered restarts ICE; after 20 s the call
  ends for both with "The connection was lost" (`call.hangup` `lost`, additive). A **poor
  connection** note from packet loss and jitter (apps and the browser phone).
- **Call waiting**: a second call to someone in a call rings softly where they're talking
  (`call.ringing` `waiting`): answer it (your call goes on hold) or let it go to voicemail at the
  usual time. On by default; a person's setting (Account) and a household phone's (Manage phone).
  Phones get it only if they say so (`hello.features`). The callee's server decides, so it works
  across servers with no federation change; servers without it stay busy.
- **Missed calls**: calls that rang and nobody answered, with no message, are kept (migration
  0029) per person (all their phones and apps, every space) or per household phone; a message
  left afterwards moves one to voicemail. Phones list them (MENU 5) with call back (`call.back`,
  as a key would dial: allow-lists and quiet hours apply), redial (MENU 8) and clear; the app has
  Missed calls on Home (call back, clear all), `GET /api/missed`, `POST /api/missed/clear`,
  `missed.changed`. `config.missed` items say their kind; the export has `missedCalls`.
- **Phones' home features** (migration 0030, all off by default, Manage phone → Home features):
  the **daily check-in** (the server watches the time and tells the guardians, even about an
  unplugged phone), the **chime** (`notice.chime`: a phone posts its words as a notice) and the
  **house intercom** key (`config.intercom`: the hardware phones' LAN intercom, signed and
  encrypted with the space's key).
- **Phones**: BACK silences a ringing call here; a notice's recording loops while the handset is
  up; a late hang-up no longer gets a second ended (it could end the sender's next call).
- **Add-on sharing** ([docs/add-ons.md](docs/add-ons.md#sharing), migration 0031). An add-on
  says which parts of itself can be shared (`addon.shares`, e.g. one shared project); its owner
  gives a share to connections or people in their spaces on the add-on's card (Settings →
  Add-ons: each share's address with Copy, Give to…, Revoke). A share has its own address,
  `handle+name+share@host`; only the people holding it get through, and the add-on is told which
  share and grant (`call.ringing.share`). It calls its owner or a holder within a share
  (`call.address.share`; they see `SEAT · BOOK CLUB`, "seat · Book club" in apps). Revoking, or
  the add-on dropping a share, ends calls into it at once. **New shared project with…** asks the
  add-on (`addon.share.request` → `addon.share.created` / `addon.share.refused`; offline and
  silent requests say so). Connections lists your add-ons and the shares given to you.
  Granting, revoking and requests are audited. Across servers: federation feature
  `addon-shares` (the call target's `share`, `CallBody.addonShare`, `POST /fed/v1/addon-shares`);
  servers without it can't receive grants or calls into shares. The Python bridge is 0.2.0
  (`set_shares`, `call.share`, `on_share_request`, `call(address, share=)`).
- **Breaking for add-ons: the whole-add-on allow-list is gone.** Since 0.6.0 an owner could let
  connections talk to an add-on as a whole; 0.7.0 drops those entries (migration 0031), shows
  the owner a one-time note on the add-on's card, removes "Who may talk to it" and
  `PUT /api/addons/:id/allow` (`POST /api/addons/link` ignores `allow`). An add-on's own address
  is its owner's alone; anyone else needs a share. An add-on that called allowed connections
  with `call.address` (no share) is refused `unavailable` now: give those people a share and
  call within it.
- **The app explains itself**: linking an add-on says what the link code is for and that sharing
  happens later on the add-on's card; Help's "What's what" says a server holds many households
  and explains owners, the recovery code and add-ons. The Python bridge shows the link code's
  expiry and whether the add-on is online.
- Protocol (additive): `call.hangup.lost`, `call.ringing.waiting`, `hello.features`,
  `config.missed[].{kind,at,count,id}`, `call.back`, `missed.changed`, `config.checkin`,
  `config.chime`, `config.intercom`, `notice.chime`, `addon.shares`, `addon.share.request`,
  `addon.share.created`, `addon.share.refused`, `call.ringing.share`, `call.ringing.from.share`,
  `call.address.share`; device features `missed-calls`, `call-waiting`, `checkin`, `chime`,
  `intercom`, `addon-shares`.

## 0.6.0 (2026-10-14, `server-v0.6.0`)

- **Add-ons** ([docs/add-ons.md](docs/add-ons.md)): a service you link to your own account (an AI
  companion, a notes taker) gets an address on it, `you+name@host`, and takes part in calls like a
  phone. Off unless the server's operator turns it on (`ADDONS=on` self-hosted, `deploy.ts
  --addons` / `npx openloungephone deploy cloudflare --addons` on Cloudflare); while it's off nobody
  can link one and linked ones can't connect or be called.
  - Linking works like pairing a phone: the add-on asks for a code (`pair.begin` `kind:
    "addon"`), you enter it under **Settings → Add-ons → Link an add-on**, choose its name and
    who may talk to it; every connection then answers a signed challenge. Removing it cuts it off
    at once and tells it to forget its link.
  - Default deny, both ways: only you, and connections you put on its list, can call it or be
    called by it, on this server or others (feature `addons`, never offered to a server that
    doesn't list it). Nobody can knock on it, it's in no directory, kids' phones never reach one,
    and a call with one can't be merged or transferred. Every call tells it who is calling
    (verified address and name).
  - Apps and phones label it: an "add-on" badge in the apps (call screen, the space's call list),
    `SEAT · ADD-ON` on the browser phone, `SEAT - ADD-ON` on firmware 0.9.3. A call with one has a
    keypad; keys reach only add-ons (`call.key`). You can put your add-on on a key of your own
    phone (and so on your keys at a Lounge phone); a connection calls one by address
    (Connections → Call an add-on).
  - Its call minutes count against its owner's fair-use allowance; linking, changes to who may
    talk to it and removing it go in the space's audit trail.
  - Protocol (additive): `call.address`, `call.key`, `call.ringing.from.kind`, `config.addon`,
    `hello.model` and `pair.begin.kind` `addon` (device feature `addons`). Federation (feature
    `addons`): the `addon` call target, `CallBody.addon`, `call.key` on the stream. Migration
    `0028_addons.sql` (two new tables).
  - **The add-on bridge** ([sdk/python](sdk/python/README.md), Python 3.10+, Apache-2.0): links,
    keeps the key and answers the challenge, reconnects, and turns calls into events and 16-bit
    PCM frames at the rate you ask for (Opus and PCMU handled by aiortc), with an echo demo.

## 0.5.0 (2026-10-14, `server-v0.5.0`)

- **Why a passkey.** Sign-up, sign-in, the passkey offer and Account explain in plain words why
  accounts use passkeys instead of passwords, and how to make one without a fingerprint or face
  sign-in (your phone by QR code, a security key, a password manager, the computer's screen lock).
  Clearer messages when a passkey is cancelled or the browser can't make one. Account suggests a
  second passkey.
- **Recovery codes.** Every account gets one recovery code when it's made (the setup link, open
  sign-up, the first invite), shown once with Copy, Download and a re-type check; accounts
  without one see a reminder until they make one (Account → Recovery code). "Lost your passkey?"
  on the start screen (also `/#recover`) takes your handle and code, has you make a new passkey,
  then shows a new code and signs you out everywhere else (on by default). The code is used up
  when the new passkey is saved (a cancelled prompt can start again), stored only as a hash,
  rate-limited per handle and network, per address and per handle a day, and never logged, audited or
  exported; the recovery is audited in every space and your other open apps are told
  (`account.notice`, additive). No email and no operator recovery.
- **Sessions.** Sessions now slide: 90 days after their last use when a passkey backs them;
  ones without (an invite or a sign-in link on a device that made no passkey) end 90 days after
  they started, and the app says when. Account → Where you're signed in lists them with Sign out
  on each and "Sign out everywhere else". Signing out, a suspension, leaving or removal from a
  space, and deleting an account close the person's open app connections at once.
- **Sign-in links only where they're safe.** A guardian's sign-in link now works only for someone
  whose only space on the server is that one, never for the owner by others, and a new one
  cancels the old; making and using one are audited. Guardians and admins see the invites and
  sign-in links not used yet and can cancel them. The link screen says who it signs you in as.
- **Owners.** Every space (homes too) has an owner: its founder until they hand it to another
  guardian or admin (People → Make owner). The owner can't be removed by others; only the owner
  changes roles, and homes can now make someone a guardian. You can leave a space yourself
  (Account); an owner hands it on first. Deleting your account no longer takes a space other
  people are in with it: you're asked to hand it on. Removing someone whose only space this is
  deletes their account, and says so. Guardians can rename people in their space; you can change
  your own name.
- **Invites.** A stale saved session no longer turns an invite into a second account (the app
  signs it out and joins signed out); a suspended one is refused. Signed in, you choose to join
  as yourself or as someone new; signed out, you can sign in first. An invite for a space you're
  already in says so.
- **Passkeys.** Removing one is confirmed; the last one goes only when you have a recovery code,
  and the app offers to sign out everywhere else. A passkey this server no longer knows gets its
  own message (and the browser is told to forget it). After signing in with your phone, the app
  offers a passkey on this device too. A wrong server address is named as such.
- **Operators by account id.** `OPERATORS` holds account ids (`acc_…`), never handles;
  `deploy.ts --operator <handle>` looks the handle up once and stores the id. **The hub needs
  `--operator jesse` on its next deploy.**
- **Hub sign-up.** The handle is checked before the person check, the check is reset after every
  try, and only accounts actually made count toward the per-address limit (tries have a looser
  one). Developer sign-in shows only in dev builds or with `?dev`. Accounts in no space can still
  sign in. Migration 0027 (additive).
## 0.4.0 (2026-10-14, `server-v0.4.0`)

- **A sign-up you can always finish.** The time zone is a list (starting on the device's own
  zone), the "are you a person?" check says when it's still checking or didn't load (with Try
  again), and the start screen never claims "invite-only" before the server answers.
- **The browser phone's MENU 2 works like the hardware's.** A person's own phone plays its
  unheard voicemail with 1 and clears messages and missed call backs with 3; the greeting moved
  to 4.
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
