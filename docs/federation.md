# Federation: connecting across Open Lounge Phone servers

Status: **F0 (accounts and several households per server) is implemented; F1–F4 are design.**
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

## Knocks (F1, design)

A knock is a contact request `POST /api/connections {to: "bob@host", note ≤ 140}`, delivered
locally or (for another server) as a signed `POST /fed/v1/knock`. The recipient accepts,
declines silently, or blocks. Limits: one pending knock per pair, 10 knocks a day per account,
knocks expire after 30 days, no re-knock for 30 days after a decline, block a person or a whole
server. Unknown handles and blocked senders get the same answer, so handles can't be enumerated.
Only accounts are knockable; household phones (kids' phones) never are, and a guardian may add an
**active** connection to a phone's allow-list.

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
  signing the new key with the old one.

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
| **F1** | Knocks and connections (locally, then across servers), server keys, `.well-known`, signed requests, disconnect, block | No calls yet; testable with l1 plus a second instance |
| **F2** | Federated **calls** (person ↔ person, person ↔ allowed phone), signaling over the server-pair stream, cross-server voicemail | Cloudflare: the household Durable Object owns federated calls; the Worker routes `/fed/v1` |
| **F3** | Phone ↔ phone calls (cousins/friends), approved by both families' guardians; shared presence | Needs phone-to-phone calling locally first |
| **F4** | Interop tests between two independent deployments in CI, a protocol spec document, versioning | Needed before anyone else runs a server in production |

## Open questions

- Whether a household can have its own shared address.
- Whether a released handle should be held back for a while before someone else can take it
  (today it's free immediately), since remote servers will have it pinned in connections.
- Whether the connection link should also work as a QR code for the Lounge phone takeover
  (likely yes).
- Whether to reuse an existing federation standard (ActivityPub, Matrix) for identity/transport.
  Current lean is **no**: our needs are narrow (connections + call signaling), and a small signed
  JSON protocol is easier to audit and to implement on a microcontroller-adjacent stack.
