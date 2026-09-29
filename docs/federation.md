# Federation: connecting across Open Lounge Phone servers

Status: **F0 (accounts, spaces) and F1 (knocks, connections, signed server-to-server requests)
are implemented; F2–F4 are design.**
Owner direction (2026-09-27): people should be able to send and accept connection invites
regardless of which server they're on, and call each other through a fair, seamless
server-to-server protocol. No central server, and the owner's public-good hub is just one more
server. The buildable phases are in the plan (`~/.claude/plans/we-build-on-this-dapper-wand.md`:
P1 = F0, P2 = F1 connections and knocks, P3 = F2 calls, P4 = the public hub, P5 = F4 interop).

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
  typo'd address therefore looks sent and quietly expires.)
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

- A person's address is **`name@host`**, e.g. `jesse@l1.openloungephone.app`. `name` is a
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
  (TLS plus trust-on-first-use, the same way SSH treats hosts). Key rotation is announced by
  signing the new key with the old one: `.well-known` then also carries `previous_key` and
  `rotation_sig` = the old key's signature over `openloungephone-key-rotation:<new key>`.
- **Keys:** Cloudflare keeps the private key in the `FED_PRIVATE_KEY` secret (generated once by
  `scripts/deploy.ts`, never regenerated); self-host keeps it in `DATA_DIR/federation-key.jwk`
  (mode 600; back it up). `FEDERATION=0` turns federation off on a self-hosted server.

### `/fed/v1` wire format (version 1)

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

Budgets per sending server (defaults): 300 requests a minute, 500 knocks a day.

## Connections (cross-server contacts)

1. Alice, on `l1`, taps **Connect with someone** and gets a **connection link**:
   `https://l1.openloungephone.app/connect#<token>`. The token is single-use, expires in 7 days,
   and names Alice.
2. Bob opens it. The page on `l1` asks **"Which server is your Open Lounge Phone account on?"**
   (with a remembered choice), or Bob pastes the link into his own app on `home.example`.
3. Bob's app asks his server to accept. **Bob's server → `l1`**: a signed
   `POST /fed/v1/connections/accept {token, from: "bob@home.example", display_name}`.
4. `l1` checks the token (single use, not expired, not revoked). Both servers then store a
   **Connection** (`local user ↔ remote address`, display name, state `active`) and each app
   shows the other person under **Connections**.
5. Either side can **disconnect** at any time. Their server notifies the other (signed), and both
   drop the connection. **Blocking** a person or a whole server stops all further requests.

The same flow covers two households on the same server (the local fast path skips HTTP). One
account can also **belong to several households**: accepting a household invite while signed
in adds a membership to the existing account instead of creating a new person.

## Presence (optional)

Connected people may share presence (online / available). A server sends signed
`presence` updates only to the servers of people you're connected to, rate-limited and batched.
Turning off "Share my availability with connections" stops them.

## Calls

- **Placing a call.** The caller's server sends a signed
  `POST /fed/v1/calls {call_id, from, to, kind: "person" | "phone"}` to the callee's server.
- **The callee's server authorizes it locally.** It needs an active connection. For a phone, the
  remote person must be on that phone's allow-list. Quiet hours (household phones only), the
  callee's availability and busy state also apply. The server then either rings its targets
  (app sessions, the person's own phones, or the allowed household phone) or answers with a
  reason (`denied`, `unavailable`, `busy`, `unreachable`, `voicemail`).
- **Signaling.** `call.state`, `rtc.sdp` and `rtc.ice` are relayed between the two servers over
  one **persistent, authenticated WebSocket per server pair**
  (`wss://<host>/fed/v1/stream`, opened by whichever side needs it first, with signed hello and
  heartbeats). Every message carries the `call_id`, and each server only forwards to the
  participant it owns. Clients see exactly the messages they see for local calls.
- **Media.** WebRTC peer-to-peer between the two clients. Each client uses its own server's TURN
  when a direct path fails. Audio never flows through either server.
- **Voicemail.** When the callee's server answers `voicemail`, the caller's app records, and the
  caller's server delivers the audio with a signed
  `POST /fed/v1/voicemail {call_id, mime, duration}` (bounded size). The callee's server stores
  and transcribes it like any local voicemail.

## Fairness and abuse controls

- **Per-remote-server budgets:** requests/min, open streams, concurrent calls, bytes/day, with
  `429` responses and backoff.
- **Per-connection budgets:** calls per hour, voicemail per day.
- **Blocklists:** a person blocks a person, a guardian blocks for the household, an operator
  blocks a server.
- Bounded, schema-validated messages (the same zod schemas as the device protocol), replay
  protection (signature `created` within ±5 min plus a nonce cache), and single-use invite
  tokens.
- Everything is logged with the remote host for the operator.

## Rollout plan

| Phase | What | Notes |
|---|---|---|
| **F0** ✔ | Accounts and handles, several households per server, one account in several households, open sign-up behind `OPEN_SIGNUP`, clear "Add a kid's phone" / "Invite a co-guardian" / "Add a household" flows | Local only; the foundation for everything else. Done (plan phase P1) |
| **F1** ✔ | Knocks and connections (locally, then across servers), server keys, `.well-known`, signed requests, disconnect, block | Done (plan phase P2); two-server e2e in `tests/e2e/twoServers.test.ts` |
| **F2** | Federated **calls** (person ↔ person, person ↔ allowed phone), signaling over the server-pair stream, cross-server voicemail | Cloudflare: the household Durable Object owns federated calls; the Worker routes `/fed/v1` |
| **F3** | Phone ↔ phone calls (cousins/friends), approved by both families' guardians; shared presence | Needs phone-to-phone calling locally first |
| **F4** | Interop tests between two independent deployments in CI, a protocol spec document, versioning | Needed before anyone else runs a server in production |

## Open questions

- Whether a household can have its own shared address.
- Whether the connection link should also work as a QR code for the Lounge phone takeover
  (likely yes).
- Whether to reuse an existing federation standard (ActivityPub, Matrix) for identity/transport.
  Current lean is **no**: our needs are narrow (connections + call signaling), and a small signed
  JSON protocol is easier to audit and to implement on a microcontroller-adjacent stack.
