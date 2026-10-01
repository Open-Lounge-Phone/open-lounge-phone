# Federation: connecting across Open Lounge Phone servers

Status: **F0 (accounts, spaces), F1 (knocks, connections, signed server-to-server requests),
F2 (federated calls, voicemail, opt-in presence, Lounge guests), rooms across servers (P3.5:
join by address, 3-way calls spanning servers) and F4 (interop tests in CI, a versioned
protocol spec) are implemented; F3 (phone ↔ phone) is planned.** This page is the readable
overview; the normative protocol an independent server can implement is
**[federation-spec.md](federation-spec.md)** (`/fed/v1`: discovery, keys, the signature
profile, every endpoint's schema, the stream, errors, versioning and security).
Owner direction (2026-09-27): people should be able to send and accept connection invites
regardless of which server they're on, and call each other through a fair, seamless
server-to-server protocol. No central server, and the owner's public-good hub is just one more
server. The buildable phases map to the README's status table: P1 = F0, P2 = F1 connections
and knocks, P3 = F2 calls, P4 = the public hub, P5 = F4 interop.

Owner decisions (2026-09-28):
- **Knock, then talk.** Anyone may send one contact request (a *knock*) to `name@server`. It is
  rate-limited and blockable, and calling works only after it's accepted. Kids' phones are never
  knockable.
- **No regular phone network, ever.** No PSTN or phone-number bridge: a closed, spam-free
  network.
- **Onboarding = a public hub plus people's own servers.** `hub.openloungephone.app` has open
  sign-up; anyone can still run their own server. Both federate as equals.
- **One account on one home server reaches everyone**, so the earlier "multi-server companion"
  idea (M6) is dropped: a companion talks only to its own home server.
- **The hub is free, funded by donations** (owner, 2026-09-28), with a fair-use allowance that
  stops abuse; see [hub.md](hub.md). Its code is ready (plan phase P4); it isn't deployed yet.
- In the UI, connections are also called **buddies**. There is no text chat.

## Principles

1. **Default deny, everywhere.** A connection has to be created explicitly and accepted before
   anyone can call. Kids' phones still only ring for people a guardian allowed. A remote person
   is simply one more entry that a guardian can put on a phone's allow-list.
2. **Your server is your authority.** Each server authorizes everything that touches its own
   users and phones: allow-lists, quiet hours, availability, busy. It never trusts another
   server's claim about those.
3. **No central directory, no open calling.** You can't search for people or call strangers.
   You reach someone by knowing their address (shared out of band, like a phone number written
   on paper) and knocking; they decide whether to accept. Connection links (below) are the
   no-knock shortcut when you're already in touch.
4. **Fair.** Every server gets the same rate limits. Any server can block another. Payloads are
   small and bounded. The owner's hub gets no special treatment.
5. **Private by default.** A server shares presence and names only with people you're connected
   to. Call audio travels peer-to-peer or through TURN, never through the other server.
6. **No phone network.** No PSTN, SMS or phone-number bridge, now or later.

## Accounts and memberships (F0, implemented)

- An **account** is one person on one server: a unique handle (`[a-z0-9._-]{2,30}`, changeable
  at most once a day; a few names like `admin` are reserved), a display name, passkeys and
  sessions. Its address is `handle@host`.
- A **membership** is the account's role (guardian or contact) in one household; one account can
  belong to several. Sessions carry the active household; clients may pin a request to another of
  their own households (`x-household`, `app.hello.household`).
- Signing up on an open server (`OPEN_SIGNUP=1`) creates the account and a personal household
  for the person's own phones. Accepting a household invite while signed in adds a membership
  instead of creating a new person.
- Migration `0006_accounts.sql` gave every existing person an account, with a handle derived
  from their name and de-duplicated (`mom`, `mom-2`, …).
- **Handle reservation (P1b):** a handle that is given up (renamed, or the account left its last
  space) is reserved for 90 days; only the account that released it can take it back meanwhile,
  because other servers may have it pinned in connections.
- **Spaces (P1b):** a household is one kind of *space*: `home` (a family), `team` or `org`
  (grown-ups). Kid-safety rules — kids' phones and quiet hours — exist only in homes. The UI
  still says "household" for homes.

## Knocks and connections (F1, implemented)

A knock is a contact request: `POST /api/connections {to: "bob@host", note ≤ 140}`. For an
address on this server it's handled directly; for another server it travels as a signed
`POST /fed/v1/knock`. The recipient sees it under **Connections → Knocks for you** and can
**Accept** (both sides become `active`), **Decline** (silent: the knocker isn't told; their knock
simply expires) or **Block**. Knocking back someone who knocked you connects you both.

- **Limits** (all in `packages/server-app/src/limits.ts`, overridable per server): one pending
  knock per pair; 10 knocks a day per account; 50 knocks a day into one inbox (the rest dropped
  silently); knocks expire after 30 days; after a decline the same person's knocks are dropped
  for 30 days; blocks (a person, or a whole server for one account) last until removed.
- **No enumeration.** Every knock gets the same answer — `202` from `/fed/v1/knock`, and `202
  {status: "sent"}` from `/api/connections` — whether the handle exists, the sender is blocked,
  cooling down after a decline, or already pending. (The plan allowed a `404` for unknown
  handles; we chose the stricter uniform answer so an address book can't be probed at all. A
  typo'd address therefore looks sent and quietly expires; the app says "If <address> exists,
  they'll get your request.")
- **Only accounts are knockable.** Household phones (kids' phones) have no address. A guardian
  can put one of their own **active** connections on a phone's allow-list
  (`PUT /api/devices/:id/remote-contacts/:connectionId`, same flags as a local contact); the
  entry (`rc_…` id, usable on speed-dial keys) disappears when the connection ends or is blocked.
- Each side keeps its own row (`connections` table, migration `0008_connections.sql`): `peer_host`
  ('' = this server), `peer_handle`, the peer's stable account id once known (handles can change),
  `state` `requested|active|declined|blocked` and `direction` `in|out`.
- Disconnecting, cancelling a knock, or blocking an active connection sends a signed
  `POST /fed/v1/connections/remove`; the other side drops its row (but keeps its own blocks and
  declines).

## Identities and discovery

- A person's address is **`name@host`**, e.g. `jesse@phone.example.com`. `name` is a
  per-server handle, unique on that server and changeable (the stable id stays internal). A
  household phone gets an address only when a guardian decides to share it.
- Every server publishes **`https://<host>/.well-known/openloungephone`**:
  ```json
  { "version": 1, "server_key": "<Ed25519 public key, base64url>",
    "federation": "/fed/v1", "software": "openloungephone/<version>" }
  ```
- **Server authentication:** every server-to-server request is signed with the server's
  Ed25519 key using HTTP Message Signatures (RFC 9421) and a `keyid` of the host. The receiver
  fetches the key over HTTPS from `.well-known`, pins it on first contact, and alerts on change
  (TLS plus trust-on-first-use, the same way SSH treats hosts). See **Key rotation** below.
- **Only public servers:** a server with a public name never contacts loopback names, IP
  literals or local-network names (`x@127.0.0.1` can't point it into its own network); servers
  on `*.localhost` (development, interop tests) talk only to each other.
- **Keys:** Cloudflare keeps the private key in the `FED_PRIVATE_KEY` secret (generated once by
  `scripts/deploy.ts`, never regenerated; after a rotation it is the root that seals the current
  key in D1); self-host keeps it in `DATA_DIR/federation-key.jwk` (mode 600; back it up).
  `FEDERATION=0` turns federation off on a self-hosted server.

### Key rotation (implemented)

An operator can replace the server's key at any time — routinely, or because the old one may
have leaked — without breaking connections:

1. **Trigger:** the Operator view's **Rotate key** button, or from a terminal
   `OLP_SESSION_TOKEN=… npx openloungephone federation rotate-key --url https://your.server`
   (the token from Operator view → "Copy session for the CLI"; asked for without echo if
   unset). Both work for Cloudflare and self-hosted servers alike, need an operator's session,
   and print only fingerprints. There is deliberately no offline command: the running server
   owns its key, so rotating through it can't race it.
2. **The server** makes a new Ed25519 key and signs with it immediately. For a 7-day **overlap
   window** its `.well-known` publishes both keys: the new `server_key` plus a `rotation`
   statement — `{previous_key, created, expires, sig}`, where the *old* key signs
   `openloungephone-key-rotation-v2`, the host, both keys and the window (the exact format is
   in [federation-spec.md §3.2](federation-spec.md#32-rotation)). It also publishes the 0.1
   `previous_key`/`rotation_sig` pair for servers still on 0.1. A second rotation inside the
   window is refused unless forced.
3. **Peers** that pinned the old key see a signature that doesn't verify, fetch `.well-known`
   once, check the statement (their pinned key signed it, for this host, within its window) and
   re-pin automatically. No valid statement — none, a bad signature, an expired or overlong
   window, or only the 0.1 pair — means the change is refused as before.
4. **Storage:** on Cloudflare the new key goes into D1 (`fed_own_key`), sealed with AES-GCM
   under a key derived from the `FED_PRIVATE_KEY` secret. We chose this over a secret because a
   Worker can only set secrets with a Cloudflare API token (which it would then have to hold),
   and `wrangler secret put` is a new deployment that needs the operator's wrangler login; the
   sealed row needs neither, and a database copy alone is useless. `deploy.ts` keeps setting
   `FED_PRIVATE_KEY` only once and never touches it again, so redeploys don't undo a rotation.
   Self-hosted, `federation-key.jwk` is replaced atomically and `federation-key.previous.json`
   keeps the old key's public half and the signed statement for the window (both mode 600).

### Pinned keys in the Operator view (implemented)

Operators see every other server's pinned key: host, fingerprint (`SHA256:…`), first seen, and
status — **pinned**, or **key change refused** with the old and new fingerprints. **Re-trust…**
asks for confirmation showing both fingerprints and then replaces the pin with the new key
(it applies only to the exact change shown; check with that server's operator first).
**Block server…** fills in the existing block form. Everything — rotations, re-trusts, blocks
and unblocks, suspensions and fair-use exemptions, plus automatic re-pins and refused key
changes — goes into the server-wide **audit trail** at the bottom of the view. All of it is
for operators only (`OPERATORS`).

### `/fed/v1` wire format (version 1)

A summary; the exact rules, schemas and error codes are in [federation-spec.md](federation-spec.md).

Every request carries:

```
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=<unix s>;
                 keyid="<sending host>";alg="ed25519";nonce="<16–64 chars>"
Signature:       sig1=:<base64 Ed25519 signature>:
Content-Digest:  sha-256=:<base64>:        (RFC 9530; required when there is a body)
```

The signature base is RFC 9421 §2.5 over those components, with `@target-uri` being the URL the
receiver is publicly reached at. The receiver checks, in order: body size (16 KiB for JSON),
shape, `created` within ±5 minutes, the digest, the signature (pinned key; one re-fetch of
`.well-known` for a rotation), then consumes the nonce (kept 11 minutes), then its operator
blocklist (`403`) and the sender's budget (`429` with `Retry-After`). Every `from` in a body is
one of the *sending* server's accounts: `{handle, id, name}` (`id` is stable, `handle` may
change). The endpoints:

| Endpoint | Body | Answer |
|---|---|---|
| `POST /fed/v1/knock` | `{from, to: handle, note?}` | always `202` |
| `POST /fed/v1/connections/accept` | `{from, to: handle}` — `from` accepts `to`'s knock | `202` (ignored unless `to` knocked `from`) |
| `POST /fed/v1/connections/remove` | `{from, to: handle}` — disconnect / cancel / block | `202` |
| `POST /fed/v1/calls` | `{callId, from, to: {kind: "person", handle} \| {kind: "phone", deviceId}, viaPhone?, guestOf?}` | `{state: "ringing"}` or `{state: "ended", reason}` |
| `GET /fed/v1/stream?from=<host>` | WebSocket: the server-pair stream (below) | `101` |
| `POST /fed/v1/voicemail?to=<deviceId>&from=&fromId=&name=&durationMs=` | raw `audio/*`, ≤ 2 MB | `201`, or `403` if not on the phone's allow-list |
| `POST /fed/v1/voicemail?kind=person&to=<handle>&from=&fromId=&name=&durationMs=&via=` | raw `audio/*`, ≤ 2 MB — for a person (`via`: the kid's phone that called, through its guardian) | `201`, or `403` without an active connection |
| `POST /fed/v1/greeting` | `{from, to: {kind: "person", handle} \| {kind: "phone", deviceId}}` — the greeting before a message | the audio with `olp-greeting: name\|custom`, `204` for the spoken default, or `403` without an active connection (a phone: `from` on its allow-list) |
| `POST /fed/v1/phones` | `{from, to: handle, phones: [{id, label}]}` — the phones `to` may call | `202` |
| `POST /fed/v1/presence` | `{from, to: [handles], online, available}` — batched, opt-in | `202` |
| `POST /fed/v1/lounge/claim` | `{from, deviceId, nonce, directory}` — the sender vouches for `from` | `{step: "press_key", expiresAt}` or `{step: "failed", reason}` |
| `POST /fed/v1/lounge/progress` | `{to: handle, deviceId, step, reason?, expiresAt?}` | `202` |
| `POST /fed/v1/lounge/dial` | `{callId, for: handle, deviceId, deviceLabel, to: address}` | like `/calls`; an `ended` answer may carry the guest's server's `voicemail` offer |
| `POST /fed/v1/lounge/leave` | `{from, deviceId}` | `202` |
| `POST /fed/v1/rooms/join` | `{leg, from, room: handle}` — `from` wants into the phone room `handle@<receiver>` | `{ok: true, roomId, name}` or `{ok: false, reason}` (`denied`, `locked`, `full`, …) |

Budgets per sending server (defaults): 300 requests a minute, 500 knocks a day.

## Presence (opt-in, implemented)

"Share my availability with my connections" (Connections screen; `PATCH /api/account
{sharePresence}`, off by default). While on, each change of the person's online/available state
in their first (personal) space goes to their active connections: directly for people on the same
server, and as one signed `POST /fed/v1/presence` per other server (batched), at most 5 a person
per 10 s; a change over that limit is coalesced (latest state only) and sent when the window
opens. Receivers keep it on the connection row (`presence_*`, migration 0009) and show it as a
dot; anything older than an hour shows as unknown. Turning it off sends "offline" once.

## Calls (F2, implemented)

- **Placing a call.** The companion sends `call.connection {connectionId}` (a person) or
  `call.phone {connectionId, deviceId}` (a household phone the connection shared); a kid's phone
  dials a connection on its allow-list with a speed-dial key. The caller's hub opens a room whose
  far end is a proxy peer, then its server sends a signed `POST /fed/v1/calls` (or, for another
  household on the same server, calls the other hub directly). `callId` names the call on both
  servers.
- **The callee's server authorizes it locally** (`FedCalls.receive`, `HouseholdHub.remoteRing`):
  an active connection with that exact account (by stable id), no block of the person or their
  server; for a phone, an allow-list entry through an active connection with `canCallDevice`,
  then quiet hours (→ `voicemail`), online and hook state; for a person, reachability,
  availability and busy. It either rings or answers with a reason (`denied`, `unavailable`,
  `busy`, `unreachable`, `voicemail`). A call to a person rings **everywhere they are**: the
  call is owned by their first (personal) space, which also rings their other spaces on that
  server (each space's app sessions, own phones and the Lounge phone they're at) and any Lounge
  phone on another server where they're a guest right now (a signed `/fed/v1/calls` with target
  `{kind: "guest", deviceId}`, accepted only from the server that vouched for them). The first
  place to answer wins; the others stop; a decline anywhere ends the call; availability still
  applies. Each place is a leg with its own call id.
- **Shared phones.** When a guardian puts a connection on a phone's allow-list with "can call",
  their server tells the other side with `POST /fed/v1/phones`; the person then sees that phone
  under the connection and can call it (and it disappears when the entry does).
- **Signaling: the server-pair stream.** `call.state`, `rtc.sdp` and `rtc.ice` travel over one
  WebSocket per server pair, `GET /fed/v1/stream?from=<host>`, routed by `callId` to the
  household that owns the call. It is **opened on demand** by whichever side needs to send first
  and **authenticated in-band**: the dialer's first frame is `{t:"hello", from, to, created,
  nonce, sig}` (Ed25519 over `olp-stream-v1\n<from>\n<to>\n<created>\n<nonce>`, ±5 min,
  single-use nonce); the acceptor answers `hello.ok` echoing the nonce, signed by itself. Then
  frames are `{t:"signal", msg}`. The **dialer closes it after 60 s with no call and no
  signaling** (an alarm/timer, re-armed only on activity), so an idle pair holds nothing open. On
  Cloudflare the `FederationObject` (one Durable Object per remote host) accepts streams with
  `acceptWebSocket` (hibernatable) and keeps call routes in storage; a stream it dialed can't
  hibernate, which is exactly why it closes when idle. There are no keepalive timers.
- **Media.** WebRTC peer-to-peer between the two clients. Each side's server hands its own client
  its own ICE servers (its own TURN). Audio never flows through either server. Clients enable
  **Opus DTX** (`usedtx=1`), so silence costs almost nothing on a relay.
- **Voicemail.** Any unanswered call goes to voicemail — no answer (the callee's server decides
  when, from their ring time), declined, busy, quiet hours (`voicemail`), unavailable or
  unreachable. The caller's own server hands its caller a single-use ticket with the ended
  `call.state` (never forwarded to the other server). With it, the caller's app or phone fetches
  the greeting (`GET /api/vm/greeting?ticket=` → the caller's server asks the callee's with a
  signed `POST /fed/v1/greeting`) and uploads the message (`POST /api/vm/message?ticket=` → a
  signed `POST /fed/v1/voicemail`, `kind=person` for a person). The callee's server checks the
  connection (and a phone's allow-list) again, stores and transcribes it, and puts it in the
  person's own inbox or tells the phone's guardians — exactly like a local voicemail. (The older
  `POST /api/connections/:id/voicemail?deviceId=` still works for a shared phone.) A guest at
  another server's Lounge phone gets voicemail too: their own server issues the offer (in the
  `/fed/v1/lounge/dial` answer or the ended `call.state` on the stream), and the Lounge phone's
  server forwards the greeting and the message to `/api/vm/*` on the guest's server, which
  delivers it as them. The only other offer that crosses servers is a **transferred call that
  nobody answers**: the team/org space's server offers its own box (ring group or member) in the
  ended `call.state`, and the caller's server relays it the same way.
- **Between households on one server** the same code runs with host `''`: the two hubs relay to
  each other directly (on Cloudflare, household Durable Object to household Durable Object).

## Rooms across servers (P3.5, implemented)

A phone room has an address like a person, `standup@host`. Someone on another server joins it
from their app by address: their server checks its own rules (fair use), registers a *leg* id
on the server-pair stream and sends a signed `POST /fed/v1/rooms/join`. The room's server
decides alone — the room must be open to connections and `from` must have an active connection
with the room's owner (a member of the space in another household on the same server gets in
anyway), then the lock and the size. After that every room message travels as
`{t: "room.signal", callId: <leg>, msg}` on the stream, both ways (`room.state`, `room.media`,
`room.idle`, `room.ended` to the participant; `room.leave`, `room.mute`, `room.talk`,
`room.here`, `room.media` and mesh `rtc.*` from them); the stream forgets a leg's route on
`room.ended` or `room.leave`. Each person's own server hands them its own ICE servers (TURN),
and the room's **media goes through the room owner's server** (its relay, or its mesh). A call
with someone on another server that is **merged** into a 3-way call carries on under the call's
id as their leg (`call.state {merged}` doesn't end the route). Room minutes are metered by each
person's own server; the room's server also counts people from other servers against the room's
owner.

**Transfers across servers** (team and org spaces only; see [workplace.md](workplace.md)): the
transferring server rings the target under a new call id and sends the other side
`call.state {state: "ended", transfer: {callId, ringing, offerer}}` for the old call; `callId` is
the new call's id on the sender's side, which the receiver uses as its leg. The receiving server
checks its own side — a kids' phone never follows; it just ends the call — opens its own
successor call for its person (or relays the notice on, e.g. from their home hub to the space
they answered in) and tells its client the same way. `ringing: true` means the receiver's person
places the new call (sends the offer); `ringing: false` connects at once (attended). If the new
call goes unanswered, the sender's `call.state ended` carries its voicemail offer (for the ring
group's box or the member) and the receiver relays it to its person. The old route
stays open until the other side answers or ends it (`transfer` doesn't end a route); if the other
server ends the old call instead of following, the sender ends the new one.

## Lounge phones across servers (F2, implemented)

A space's guardians can let people from other servers use its Lounge phones (Lounge settings →
"Let people from other servers use these phones"; off by default). Someone without an account
on the phone's server scans its code, enters their own address, and continues on their own
server (`/lounge#<device>.<nonce>@<phone's host>`). Their server **vouches** for them with a
signed `POST /fed/v1/lounge/claim` carrying their speed-dial (their connections, ≤ 10) and
records that it vouched (`lounge_away`, migration 0009). The phone then asks for the same key
press as for a member. While the session lasts, the phone greets them and its keys dial their
directory: the phone's server sends `POST /fed/v1/lounge/dial` and the **guest's server places
the call as them** — its own rules and connections — relaying between the two legs (the call has
its own id on each). The guest's server refuses dial requests unless it has a live vouched session
at that phone. Sessions end as usual (log out, leave from the guest's app, idle, a new takeover)
and immediately if the phone disconnects; guardians see "who, where, when" with the guest's
address. Calls *to* the guest ring the Lounge phone they're at as well as their own apps.

## Fairness and abuse controls

- **Per-remote-server budgets:** requests/min, open streams, concurrent calls, bytes/day, with
  `429` responses and backoff.
- **Per-connection budgets:** calls per hour, voicemail per day.
- **Blocklists:** a person blocks a person, a guardian blocks for the household, an operator
  blocks a server.
- Bounded, schema-validated messages (the same zod schemas as the device protocol), replay
  protection (signature `created` within ±5 min plus a nonce cache), and single-use invite
  tokens.
- Everything is logged with the remote host for the operator; key changes, re-trusts and
  blocks also go into the operators' audit trail.

## Rollout plan

| Phase | What | Notes |
|---|---|---|
| **F0** ✔ | Accounts and handles, several households per server, one account in several households, open sign-up behind `OPEN_SIGNUP`, clear "Add a kid's phone" / "Invite a co-guardian" / "Add a household" flows | Local only; the foundation for everything else. Done (plan phase P1) |
| **F1** ✔ | Knocks and connections (locally, then across servers), server keys, `.well-known`, signed requests, disconnect, block | Done (plan phase P2); two-server e2e in `tests/e2e/twoServers.test.ts` |
| **F2** ✔ | Federated **calls** (person ↔ person, person ↔ allowed phone, phone → connection), signaling over the on-demand server-pair stream, cross-server voicemail, opt-in presence, Lounge guests | Done (plan phase P3). Cloudflare: `FederationObject` per remote host |
| **F3** | Phone ↔ phone calls (cousins/friends), approved by both families' guardians | Planned; needs phone-to-phone calling locally first |
| **F4** ✔ | Interop tests between two independent deployments in CI, a protocol spec document, versioning | Done (plan phase P5): the `Interop` workflow runs two self-hosted servers and two Workers (`wrangler dev`) against each other on every push; [federation-spec.md](federation-spec.md) is the versioned spec |

## Open questions

- Whether a household can have its own shared address.
- Whether to reuse an existing federation standard (ActivityPub, Matrix) for identity/transport.
  Current lean is **no**: our needs are narrow (connections + call signaling), and a small signed
  JSON protocol is easier to audit and to implement on a microcontroller-adjacent stack.
