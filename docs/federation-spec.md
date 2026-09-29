# Open Lounge Phone federation protocol, version 1 (`/fed/v1`)

Status: **normative**, version 1 as implemented by Open Lounge Phone 0.1. The readable overview,
with the reasons behind the design, is [federation.md](federation.md); where the two differ,
this document wins. The endpoint reference (§7) and the stream frames (§6.3) are generated from
the zod schemas in `packages/federation` (`npm run docs:federation`; CI fails when they drift).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119 and
RFC 8174 when they appear in capitals.

## Contents

1. [Scope and model](#1-scope-and-model)
2. [Discovery](#2-discovery)
3. [Server keys and pinning](#3-server-keys-and-pinning)
4. [Request signatures (RFC 9421 profile)](#4-request-signatures-rfc-9421-profile)
5. [Processing a request: order, errors and rate limits](#5-processing-a-request-order-errors-and-rate-limits)
6. [The server-pair stream](#6-the-server-pair-stream)
7. [Endpoints](#7-endpoints)
8. [Semantics](#8-semantics)
9. [Versioning and compatibility](#9-versioning-and-compatibility)
10. [Security considerations](#10-security-considerations)
11. [Implementation notes](#11-implementation-notes)

## 1. Scope and model

- A **server** is identified by its **host**: the DNS name, with `:port` when it isn't the
  default, of the URL people reach it at (its `PUBLIC_URL`). Hosts are lower case and match
  `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$`.
- An **account** is one person on one server. Its **address** is `handle@host`, where `handle`
  matches `^[a-z0-9._-]{2,30}$` and may change (at most once a day; a released handle is
  reserved for 90 days). Every account also has a stable **id** (`[A-Za-z0-9_-]{1,64}`) that
  never changes. A **party** (`Party`, §7) is `{handle, id, name}` of one account.
- A **connection** is a pair of accounts that both agreed to talk (a knock, then an accept).
  Each server keeps its own record of it and MUST identify the remote side by `(host, id)`,
  not by handle.
- **Household phones** (e.g. a kids' phone) have no address. A guardian may list a connection
  on such a phone's allow-list; the phone's server then shares it with `/fed/v1/phones`.
- **Your server is your authority.** A server MUST decide everything that concerns its own
  accounts and phones (connections, allow-lists, quiet hours, availability, busy, blocks,
  recording policy) by itself, and MUST NOT act on another server's claim about them. A
  sending server speaks only for its own accounts: every `from` in a request is an account of
  the server whose key signed it.
- There is no directory, no search and no phone network bridge. Nothing in this protocol lets
  a server list another server's accounts.

## 2. Discovery

Every federating server MUST serve `GET https://<host>/.well-known/openloungephone` (plain
`http://` only for `localhost` and `*.localhost`, which are loopback by definition and are
used for development and interop tests):

```json
{ "version": 1, "server_key": "<Ed25519 public key, base64url, 43 chars>",
  "federation": "/fed/v1", "software": "openloungephone/0.1" }
```

- `version` is the highest federation version the server speaks; `federation` is the base path
  of version 1. See §9 for how later versions are advertised.
- `server_key` is the raw 32-byte Ed25519 public key, base64url without padding.
- `previous_key` and `rotation_sig` are present only after a key rotation (§3.2).
- A server that does not federate answers `404`. The document MAY be cached for up to 300 s
  (`Cache-Control: public, max-age=300`).

## 3. Server keys and pinning

### 3.1 Trust on first use

A receiver learns a sender's key from the sender's `.well-known`, over HTTPS, the first time it
needs it (the `keyid` of a signed request, or the `from` of a stream `hello`), and MUST pin
it: store `(host, key)` and use the stored key from then on. Implementations SHOULD record when
the key was first and last seen. This is TLS plus trust-on-first-use, as SSH treats hosts.

When a signature does not verify with the pinned key, the receiver MUST fetch `.well-known`
again, once, and then:

1. same key as pinned → the signature is bad (`401 signature: bad_signature`);
2. a different key with a valid rotation (§3.2) → pin the new key and verify with it;
3. any other different key → MUST NOT pin it; SHOULD record it for the operator ("SERVER KEY
   CHANGED"); the request fails with `401`.

A receiver MUST NOT fetch keys for hosts it would not contact (§10.4).

### 3.2 Rotation

To rotate, a server publishes its new key as `server_key` together with

- `previous_key`: the key it replaces (the one peers have pinned), and
- `rotation_sig`: the old key's Ed25519 signature, base64url, over the UTF-8 bytes of
  `openloungephone-key-rotation:<new server_key>`.

A receiver accepts the new key only if `previous_key` equals its pinned key and `rotation_sig`
verifies with it. A server SHOULD keep publishing `previous_key`/`rotation_sig` for at least 90
days after rotating, so peers that were offline catch up; a peer that pinned a key two
rotations old cannot follow and needs its operator.

### 3.3 Private keys

The private key MUST be generated once per server and kept secret (the reference
implementation stores it as a JWK: the `FED_PRIVATE_KEY` secret on Cloudflare,
`DATA_DIR/federation-key.jwk` with mode 600 when self-hosted). Losing it breaks every
connection with servers that pinned it.

## 4. Request signatures (RFC 9421 profile)

Every request to a signed endpoint (§7) MUST carry an HTTP Message Signature
([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)) in exactly this profile:

```
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1790000000;keyid="a.example";alg="ed25519";nonce="Zm9vYmFyYmF6cXV4MTIzNA"
Signature:       sig1=:<base64 Ed25519 signature>:
Content-Digest:  sha-256=:<base64 SHA-256 of the body>:
```

- **Label:** exactly one signature, labelled `sig1`.
- **Covered components:** `"@method"` and `"@target-uri"` always, in that order, then
  `"content-digest"` when the request has a body. Receivers MUST reject a signature that does
  not cover these (`401 signature: components`).
- **Parameters:** `created` (integer Unix seconds), `keyid` (the sending server's host,
  exactly as in its addresses), `alg="ed25519"`, and `nonce` (16–64 characters; senders SHOULD
  use 16 random bytes, base64url). No other parameters are used; `expires` MUST NOT be relied
  on. Parameters appear once each; string values contain no `"` or `\`.
- **`@target-uri`:** the absolute URL the sender requests, `https://<receiver host><path>[?query]`.
  The receiver MUST reconstruct it from its *own public origin* (its `PUBLIC_URL`) plus the
  request's path and query, never from a `Host` or forwarding header, so a signature for one
  server, path or version can't be replayed against another.
- **`Content-Digest`:** [RFC 9530](https://www.rfc-editor.org/rfc/rfc9530) `sha-256` over
  the exact body bytes, for every request with a body (JSON or audio).
- **Signature base** (RFC 9421 §2.5), lines joined with `\n`, no trailing newline (illustrative
  values):

  ```
  "@method": POST
  "@target-uri": https://b.example/fed/v1/knock
  "content-digest": sha-256=:X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE=:
  "@signature-params": ("@method" "@target-uri" "content-digest");created=1790000000;keyid="a.example";alg="ed25519";nonce="Zm9vYmFyYmF6cXV4MTIzNA"
  ```

  `@method` is upper case. The signature is Ed25519 over the UTF-8 bytes of the base, sent as
  standard base64 (with padding) between colons.
- **Freshness:** receivers MUST reject `created` more than **300 s** away from their clock
  (`401 signature: expired`). Servers SHOULD keep their clocks in sync (NTP).
- **Nonces:** after the signature verifies — and only then, so forged requests can't burn real
  nonces — the receiver MUST record `(keyid, nonce)` for at least the whole acceptance window
  plus a margin (the reference keeps them 11 minutes) and MUST reject a nonce it has seen
  (`401 signature: replay`). A sender MUST use a fresh nonce and `created` for every request,
  including retries.

The stream upgrade (`GET /fed/v1/stream`) is not signed this way; it authenticates in-band
(§6.1). The voicemail ticket endpoints (§8.4) use tickets, not signatures.

## 5. Processing a request: order, errors and rate limits

A receiver processes a signed request in this order and answers the first failure:

| Step | Failure | Status | Body `error` |
|---|---|---|---|
| Federation enabled | this server doesn't federate | `404` | `this server doesn't federate` |
| Body size (`Content-Length`, then actual): 16 KiB for JSON, 2 MiB for voicemail audio | too large | `413` | `too large` |
| Signature headers present and well-formed; `alg`; covered components; `created` window; digest; key (§3); signature; nonce | see reason | `401` | `signature: <reason>` with reason `missing`, `malformed`, `alg`, `components`, `expired`, `digest`, `unknown_key`, `bad_signature` or `replay` |
| The operator's server blocklist | sender blocked | `403` | `blocked` |
| The sender's request budget (default **300 requests a minute** per sending server, over all signed endpoints) | over budget | `429` + `Retry-After: 60` | `slow down` |
| Endpoint budget: `/knock` (default **500 knocks a day** per sending server) | over budget | `429` + `Retry-After: 3600` | `slow down` |
| JSON parse | invalid | `400` | `invalid JSON` |
| Schema (§7) | invalid | `400` | `invalid body` (voicemail: `invalid sender`) |

Every error body is `{"error": "<short reason>"}`; clients MUST NOT parse the text. Endpoint
outcomes that are the receiver's business answer `202` whatever happened (§8.1); decisions
the caller needs answer `200` with a result object (calls, room joins, Lounge claims).

**Senders:**

- MUST treat `429` as "try later": honour `Retry-After`, and for a call answer the caller with
  `busy` rather than retrying while it rings.
- MUST NOT retry other `4xx` unchanged. MAY retry network errors and `5xx` with exponential
  backoff, re-signing each attempt (fresh `created` and `nonce`).
- SHOULD treat a peer's `404` on an endpoint newer than the peer's advertised version as
  "not supported" (§9).

**Budgets** are fair defaults, the same for every sending server (the public hub gets no
special treatment); operators MAY change them. Per-account limits also apply and are silent
where revealing them would leak information (§8.1).

## 6. The server-pair stream

Call and room signaling between two servers travels over one WebSocket per server pair.

### 6.1 Opening and authentication

- It is **opened on demand** by whichever server first needs to send a signal: the *dialer*
  connects to `wss://<peer host>/fed/v1/stream?from=<own host>` (`ws://` for loopback hosts).
- The dialer's first frame MUST be `hello`: `{t: "hello", from: <dialer host>, to: <acceptor
  host>, created, nonce, sig}`, where `sig` is the dialer's Ed25519 signature (base64url) over
  the UTF-8 statement

  ```
  olp-stream-v1\n<from>\n<to>\n<created>\n<nonce>
  ```

- The acceptor MUST check that `from` equals the `from` query parameter, `to` is its own host,
  `created` is within ±300 s, the signature verifies with the pinned key of `from` (§3; one
  re-fetch for rotation), and the nonce is unused (remembered 11 minutes). It then answers
  `hello.ok` with `from`/`to` swapped, its own `created`, **the dialer's nonce**, and its own
  signature over the same statement form. The dialer MUST check `hello.ok` the same way,
  including that the nonce echoes its own.
- Any failure closes the socket with code **4401** and a short reason. Before authentication
  the only acceptable frame is `hello` (acceptor) or `hello.ok` (dialer). A reference server
  refuses an upgrade whose `from` is not a host with `400` (Workers) or close code `4400`.
- Signals the dialer wants to send wait until `hello.ok`; then they go out in order.

### 6.2 Messages and routing

- After authentication, every frame is `{t: "signal", msg}` (§6.3). Frames MUST be at most
  16 KiB. Both sides MAY send on any authenticated socket between them (if both dialed at the
  same time there may briefly be two).
- `msg.callId` names a call (or a room leg) **as the receiver knows it**. A server registers
  the ids it expects (before sending `/calls`, `/rooms/join` or a transfer notice, and when it
  accepts one) and routes each inbound signal to the call it belongs to. Signals for unknown ids
  MUST be dropped silently.
- A route ends with `call.state ended` — unless it carries `merged` (the call continues as a
  room leg under the same id) or `transfer` (the other side may still answer that it won't
  follow) — and with `room.signal` carrying `room.ended` or `room.leave`.
- Malformed signal frames are ignored (logged); they don't close the stream.

### 6.3 Frames

<!-- BEGIN GENERATED: stream (npm run docs:federation) -->
**Handshake frames** (`hello` from the dialer, `hello.ok` from the acceptor)

| Field | Type | Required | Notes |
|---|---|---|---|
| `t` | `"hello"` \| `"hello.ok"` | yes |  |
| `from` | string (len ≥1, len ≤260) | yes | The sender of this frame (host, with port if any). |
| `to` | string (len ≥1, len ≤260) | yes | The other end (host, with port if any). |
| `created` | integer | yes | Unix time in seconds. |
| `nonce` | string (`^[A-Za-z0-9_-]{16,64}$`) | yes | The dialer's random nonce; `hello.ok` echoes it. |
| `sig` | string (len ≤128) | yes | base64url Ed25519 signature over `streamStatement(from, to, created, nonce)`. |

**Signal frames** — `{"t": "signal", "msg": …}`, where `msg` is one of `call.state`, `rtc.sdp`, `rtc.ice`, `room.signal` (the shapes in [protocol.md](protocol.md), with `callId` naming the call or room leg on the receiving side).

**Room signals** — `msg` of a `room.signal` is one of `room.state`, `room.media`, `room.idle`, `room.ended`, `room.leave`, `room.mute`, `room.remove`, `room.lock`, `room.talk`, `room.here`, `rtc.sdp`, `rtc.ice`.

**Timing constants** — signature and `hello` freshness ±300 s; nonces remembered 11 minutes.
<!-- END GENERATED: stream -->

### 6.4 Idle close

- The **dialer** MUST close its socket (code `1000`, reason `idle`) once **60 s** pass with no
  active call or room leg on the stream and no signal in either direction. While calls are up it
  SHOULD look again at least every 10 minutes, and SHOULD stop counting a call that has had no
  signaling for 6 hours (a lost hangup must not pin the stream open).
- The **acceptor** never closes for idleness (on Cloudflare its Durable Object hibernates).
- There are no keepalive pings. A closed stream is simply dialed again when the next signal
  needs it; a server MUST NOT assume a signal was delivered because a socket was open.
- `1001` means the server is shutting down.

## 7. Endpoints

<!-- BEGIN GENERATED: endpoints (npm run docs:federation) -->
Federation version 1, base path `/fed/v1`. JSON bodies are at most 16384 bytes; voicemail audio at most 2097152 bytes. Every refusal carries { error: string (len ≤200) }.

| Endpoint | Signed | Summary |
|---|---|---|
| `GET /.well-known/openloungephone` | no | Discovery: the server's federation key and where `/fed/v1` lives. |
| `POST /fed/v1/knock` | yes | A contact request from `from` to `to`. |
| `POST /fed/v1/connections/accept` | yes | `from` accepts the knock that `to` sent them. |
| `POST /fed/v1/connections/remove` | yes | `from` disconnected from `to`, cancelled a knock, or blocked `to`. |
| `POST /fed/v1/calls` | yes | Ring someone on the receiving server for `from`. |
| `GET /fed/v1/stream` | no | WebSocket upgrade: the server-pair stream, authenticated in-band by `hello`. |
| `POST /fed/v1/voicemail` | yes | A voicemail message for a phone here, or with `kind=person` for a person here. |
| `POST /fed/v1/greeting` | yes | The greeting to play before `from` leaves a message for `to`. |
| `POST /fed/v1/phones` | yes | The household phones `to` may call through their connection with `from`. |
| `POST /fed/v1/presence` | yes | `from`'s availability, for their connections on the receiving server (opt-in). |
| `POST /fed/v1/lounge/claim` | yes | The sender vouches that its account `from` scanned the receiver's Lounge phone. |
| `POST /fed/v1/lounge/progress` | yes | The receiver's account's takeover of the sender's Lounge phone moved on. |
| `POST /fed/v1/lounge/dial` | yes | A guest (the receiver's account `for`) pressed a key on the sender's Lounge phone; the receiver places the call as them. |
| `POST /fed/v1/lounge/leave` | yes | `from` leaves the receiver's Lounge phone (from their own app). |
| `POST /fed/v1/rooms/join` | yes | `from` asks into the phone room `room@<receiver>`; `leg` names their side. |

### `GET /.well-known/openloungephone`

Discovery: the server's federation key and where `/fed/v1` lives.

Not signed.

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | { version: integer, server_key: string (`^[A-Za-z0-9_-]{43}$`), federation: string, software?: string (len ≤64), previous_key?: string (`^[A-Za-z0-9_-]{43}$`), rotation_sig?: string (len ≤128) } | Cacheable for up to 300 s. |
| 404 | — | The server does not federate. |

**Receiver rules**

- Served over HTTPS (plain HTTP only for `localhost` and `*.localhost`).
- `server_key` is the raw 32-byte Ed25519 public key, base64url without padding.

### `POST /fed/v1/knock`

A contact request from `from` to `to`.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | string (`^[a-z0-9._-]{2,30}$`) | yes | A handle on the receiving server. |
| `note` | string (len ≤140) |  | A short note shown with the request. |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always, whether or not the handle exists, the sender is blocked, cooling down or already pending. |
| 429 | — | The sending server exceeded its daily knock budget (`Retry-After`). |

**Receiver rules**

- MUST NOT reveal whether `to` exists: unknown handles, blocks, cooldowns and duplicates all answer 202.
- Knocking back someone who knocked you connects both (the receiver sends `/connections/accept`).

### `POST /fed/v1/connections/accept`

`from` accepts the knock that `to` sent them.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | string (`^[a-z0-9._-]{2,30}$`) | yes | The handle (on the receiving server) whose knock `from` accepts. |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always; ignored unless `to` has a pending knock to `from`. |

**Receiver rules**

- Both sides' rows become `active`; calls are allowed only from now on.

### `POST /fed/v1/connections/remove`

`from` disconnected from `to`, cancelled a knock, or blocked `to`.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | string (`^[a-z0-9._-]{2,30}$`) | yes | The handle (on the receiving server) `from` disconnects from. |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always. |

**Receiver rules**

- The receiver drops its row for the pair (keeping its own blocks and declines) and any phone allow-list entries made through it.

### `POST /fed/v1/calls`

Ring someone on the receiving server for `from`.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `callId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes | Chosen by the caller's server; names the call on both servers. |
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | `CallTarget` | yes |  |
| `viaPhone` | { label: string (len ≥1, len ≤24) } |  | A household phone (e.g. a kid's) calls through `from`'s connection. |
| `guestOf` | string (len ≤260) |  | `from` is a guest at one of the sender's Lounge phones, from this host. |
| `ringLabel` | string (len ≥1, len ≤24) |  | What to show while ringing, when it isn't `from.name`. |
| `recording` | boolean |  | The caller's space records this call; the receiver may refuse (`denied` + `note`). |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | { state: `"ringing"` } \| { state: `"ended"`, reason: `"hangup"` \| `"declined"` \| `"busy"` \| `"denied"` \| `"voicemail"` \| `"timeout"` \| `"unreachable"` \| `"unavailable"` \| `"error"`, note?: string (len ≤200), voicemail?: `VoicemailOffer` } | `ringing`, or `ended` with a reason; never a `voicemail` offer (that is the caller's server's to make). |

**Receiver rules**

- Decided by the receiver alone: an active connection with `from` by stable id (for a phone, an allow-list entry through such a connection with `canCallDevice`), no block of the person or server, then quiet hours (`voicemail`), reachability, availability and busy.
- `guest` targets are accepted only from the server that vouched for that guest at that Lounge phone.
- Signaling for `callId` then travels on the server-pair stream.

### `GET /fed/v1/stream`

WebSocket upgrade: the server-pair stream, authenticated in-band by `hello`.

Not signed.

**Query parameters**

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | string (len ≥1, len ≤260) | yes | The dialing server's host (checked by `hello`). |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 101 | — | Switching protocols; the dialer's first frame MUST be `hello`. |
| 400 | — | `from` is not a host name. |

**Receiver rules**

- See [the stream](#6-the-server-pair-stream).

### `POST /fed/v1/voicemail`

A voicemail message for a phone here, or with `kind=person` for a person here.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Query parameters**

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string (len ≥1, len ≤64) | yes | A phone's device id, or with `kind=person` a handle. |
| `kind` | `"person"` |  |  |
| `from` | string (`^[a-z0-9._-]{2,30}$`) | yes | The sender's handle on the sending server. |
| `fromId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes | The sender's stable account id. |
| `name` | string (len ≥1, len ≤64) | yes | The sender's display name. |
| `durationMs` | string (`^\d{1,7}$`) | yes | Length in ms (capped at 120000). |
| `via` | string (len ≤24) |  | With `kind=person`: the sender's kids' phone that called, through its guardian. |

**Request body:** The raw recording (`Content-Type: audio/*`), at most 2 MiB; `Content-Digest` covers it.

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 201 | { ok: `true` } | Stored (and transcribed if the server does that). |
| 403 | — | No active connection with the sender (a phone: the sender isn't on its allow-list). |
| 400 | — | Invalid sender fields or an empty body. |
| 413 | — | Larger than 2 MiB. |
| 415 | — | Not `audio/*`. |

**Receiver rules**

- The sender is `from`/`fromId`/`name` on the *signing* server; the receiver re-checks the connection (and allow-list) at delivery time.

### `POST /fed/v1/greeting`

The greeting to play before `from` leaves a message for `to`.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | { kind: `"person"`, handle: string (`^[a-z0-9._-]{2,30}$`) } \| { kind: `"phone"`, deviceId: string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) } | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | — | The audio (`Content-Type: audio/*`) with header `olp-greeting: name\|custom`. |
| 204 | — | Use the spoken default greeting (`olp-greeting: default`). |
| 403 | — | No active connection (a phone: `from` not on its allow-list). |

**Receiver rules**

- Not cached by the caller's server beyond the one voicemail it serves.

### `POST /fed/v1/phones`

The household phones `to` may call through their connection with `from`.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | string (`^[a-z0-9._-]{2,30}$`) | yes |  |
| `phones` | { id: string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`), label: string (len ≥1, len ≤24) }[] (0–16) | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always. |

**Receiver rules**

- Replaces the previous list for that connection; an empty list clears it.

### `POST /fed/v1/presence`

`from`'s availability, for their connections on the receiving server (opt-in).

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `to` | string (`^[a-z0-9._-]{2,30}$`)[] (1–200) | yes | `from`'s active connections on the receiving server (one request per server). |
| `online` | boolean | yes | Has a live app session or phone. |
| `available` | boolean | yes | Takes calls right now (their own availability switch). |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always; entries in `to` without an active connection are ignored. |

**Receiver rules**

- Sent only while `from` opted in; batched per receiving server; at most 5 per person per 10 s (later changes coalesce to the latest state).
- Receivers treat presence older than an hour as unknown.

### `POST /fed/v1/lounge/claim`

The sender vouches that its account `from` scanned the receiver's Lounge phone.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `deviceId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |
| `nonce` | string (`^[A-Za-z0-9_-]{16,64}$`) | yes |  |
| `directory` | { address: string (len ≤300), name: string (len ≥1, len ≤64) }[] (0–10) | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | { step: `"press_key"`, expiresAt: integer } \| { step: `"failed"`, reason: `"expired"` \| `"wrong_key"` \| `"timeout"` \| `"busy"` \| `"not_found"` } | Next step, or why not. |

**Receiver rules**

- Refused (`not_found`) unless the phone's space lets people from other servers use it.
- The single-use `nonce` from the phone's code must match; then the phone asks for the same key press as for a member.

### `POST /fed/v1/lounge/progress`

The receiver's account's takeover of the sender's Lounge phone moved on.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string (`^[a-z0-9._-]{2,30}$`) | yes |  |
| `deviceId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |
| `step` | `"press_key"` \| `"started"` \| `"failed"` \| `"ended"` | yes |  |
| `reason` | string (len ≤32) |  |  |
| `expiresAt` | integer (≥0) |  |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always; ignored unless the receiver vouched for `to` at that phone. |

### `POST /fed/v1/lounge/dial`

A guest (the receiver's account `for`) pressed a key on the sender's Lounge phone; the receiver places the call as them.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `callId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |
| `for` | string (`^[a-z0-9._-]{2,30}$`) | yes |  |
| `deviceId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |
| `deviceLabel` | string (len ≥1, len ≤24) | yes |  |
| `to` | string (len ≤300) | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | { state: `"ringing"` } \| { state: `"ended"`, reason: `"hangup"` \| `"declined"` \| `"busy"` \| `"denied"` \| `"voicemail"` \| `"timeout"` \| `"unreachable"` \| `"unavailable"` \| `"error"`, note?: string (len ≤200), voicemail?: `VoicemailOffer` } | Like `/calls`; an `ended` answer may carry the guest's server's `voicemail` offer. |

**Receiver rules**

- Refused (`denied`) unless the receiver has a live vouched session for `for` at `deviceId` on the sender, and `to` is one of `for`'s active connections.

### `POST /fed/v1/lounge/leave`

`from` leaves the receiver's Lounge phone (from their own app).

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `from` | `Party` | yes | One of the sending server's accounts. |
| `deviceId` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 202 | { ok: `true` } | Always. |

### `POST /fed/v1/rooms/join`

`from` asks into the phone room `room@<receiver>`; `leg` names their side.

Signed (RFC 9421 profile, §4). Unsigned or badly signed requests get `401`.

**Request body** (`application/json`)

| Field | Type | Required | Notes |
|---|---|---|---|
| `leg` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes |  |
| `from` | `Party` | yes | One of the sending server's accounts. |
| `room` | string (`^[a-z0-9._-]{2,30}$`) | yes |  |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| 200 | { ok: `true`, roomId: string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`), name: string (len ≤64) } \| { ok: `false`, reason: `"denied"` \| `"locked"` \| `"full"` \| `"unreachable"` \| `"busy"` \| `"error"`, note?: string (len ≤200) } | Admitted, or why not. |

**Receiver rules**

- Decided by the room's server: open to connections and `from` connected with the room's owner, then the lock and the size.
- Everything after admission travels as `room.signal` on the stream, keyed by `leg`.

**Call end reasons** (`CallResult.reason`, `call.state.reason`): `hangup`, `declined`, `busy`, `denied`, `voicemail`, `timeout`, `unreachable`, `unavailable`, `error`
<!-- END GENERATED: endpoints -->

### 7.1 Shared types

<!-- BEGIN GENERATED: types (npm run docs:federation) -->
#### `Party`

One of the sending server's accounts.

| Field | Type | Required | Notes |
|---|---|---|---|
| `handle` | string (`^[a-z0-9._-]{2,30}$`) | yes | Current handle on the sending server (may change). |
| `id` | string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) | yes | Stable account id on the sending server (never changes). |
| `name` | string (len ≥1, len ≤64) | yes | Display name. |

#### `CallTarget`

One of:

- { kind: `"person"`, handle: string (`^[a-z0-9._-]{2,30}$`) }
- { kind: `"phone"`, deviceId: string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) }
- { kind: `"guest"`, deviceId: string (len ≥1, len ≤64, `^[A-Za-z0-9_-]+$`) }

#### `VoicemailOffer`

The call wasn't answered (no answer, declined, busy, quiet hours, unavailable, offline): the caller may leave a message. Play the greeting, the tone, record until hang-up, then upload.

| Field | Type | Required | Notes |
|---|---|---|---|
| `ticket` | string (len ≥16, len ≤128) | yes | Single use, expires in 10 minutes. `GET /api/vm/greeting?ticket=` returns the greeting audio (`olp-greeting: name\|custom`) or 204 for the default; `POST /api/vm/message?ticket=&durationMs=` with a raw `audio/*` body leaves the message. |
| `name` | string (len ≥1, len ≤24) | yes | Who was called, for the spoken default greeting. |
| `maxMs` | integer | yes | Longest message accepted (2 minutes). |
| `prompts` | (`"name"` \| `"greeting"` \| `"vm.person"` \| `"vm.cant_take"` \| `"vm.leave_message"` \| `"vm.tone"` \| `"vm.sent"` \| `"vm.not_sent"` \| `"greet.say_name"` \| `"greet.say_greeting"` \| `"greet.saved"` \| `"greet.not_saved"` \| `"greet.default"` \| `"greet.not_allowed"`)[] (0–8) | yes | What to play before recording, in order, for the `default` and `name` greetings: `["name","vm.cant_take","vm.leave_message","vm.tone"]`. For a `custom` greeting play `greeting`, then `vm.tone`. |
<!-- END GENERATED: types -->

## 8. Semantics

### 8.1 Knocks and connections

- **Knock** (`/knock`): `from` asks to connect with `to`. The receiver MUST answer `202` in every
  case — unknown handle, the sender blocked or cooling down after a decline, a duplicate, or an
  inbox over its daily limit (default 50 a day per account, the rest dropped silently) — so an
  address book can't be probed. Only accounts are knockable; household phones never are.
- **Accept** (`/connections/accept`): the knocked account accepts; both sides mark the
  connection active. If the receiver's `to` knocked `from` earlier, that is the match;
  otherwise the request is ignored. Knocking someone who already knocked you is an accept.
- **Decline** sends nothing: the knock just expires (30 days) on the knocker's side, and the
  decliner's server drops that person's further knocks for 30 days.
- **Remove** (`/connections/remove`): disconnect, cancel a pending knock, or block. The receiver
  drops its row for that pair, and anything granted through it (phone allow-list entries, shared
  phones, presence), but keeps its own blocks and declines.
- Senders limit their own accounts (defaults: 10 knocks a day per account, one pending knock per
  pair); a public server may add a monthly allowance.

### 8.2 Calls

- The caller's server checks its own rules, then sends `/calls` with a `callId` it chose and
  registers that id on the stream. The callee's server authorizes alone (§7, `/calls` rules)
  and answers `ringing` or `ended` + reason. `denied` MUST be used for every authorization
  failure, so a caller can't tell "no connection" from "blocked".
- A call to a person rings everywhere the person is on their server; the first place to answer
  wins. The callee's server decides when it stops ringing (its ring time, 10–60 s) and then
  sends `call.state ended` with `timeout`. Callers MUST NOT end the call on their own ring
  timer before a generous backstop (the reference uses the maximum ring time plus 5 s).
- **Signaling on the stream**, from the side that owns the event:
  - the callee's server sends `call.state connecting` when someone answers;
  - **the party that placed the call sends the SDP offer** (`rtc.sdp offer`), the callee's side
    answers (`rtc.sdp answer`); `rtc.ice` flows both ways; the side that relays the answer
    marks the call `active` and both sides send `call.state active`;
  - `call.state ringing` and `rtc.config` never cross: each server rings its own people and
    hands its own clients its own ICE servers (its own TURN);
  - either side ends with `call.state ended` + reason; `hold` on an `active` state is from the
    *receiver's* person's point of view (`them` = the other side put the call on hold).
- **Media** is WebRTC between the two clients, peer to peer or through each side's own TURN;
  it never flows through either server for a 1:1 call. Clients SHOULD enable Opus DTX.
- A call **merged** into a 3-way call ends with `call.state ended` + `merged {roomId}` and
  continues as a room leg under the same id (§8.6).

### 8.3 Presence

Presence is opt-in per account and goes only to that account's active connections. A server
sends one `/presence` per receiving server with every connected handle there in `to` (at most
200 per request), at most 5 changes per person per 10 s; changes over that are coalesced (only
the latest state is sent when the window opens). Turning presence off sends `online: false`
once. Receivers MUST ignore handles in `to` that have no active connection with `from`, and
SHOULD show presence older than an hour as unknown.

### 8.4 Voicemail and greetings

- **Who offers.** When a call goes unanswered (no answer, declined, busy, quiet hours →
  `voicemail`, unavailable, unreachable), **the caller's own server** offers voicemail to its
  caller (a `VoicemailOffer` with a single-use ticket in its own `call.state ended`). The
  callee's server MUST NOT put an offer in `/calls` answers or in `call.state` on the stream,
  with exactly two exceptions: a Lounge guest's call (§8.5) and an unanswered transfer (§8.7).
  Receivers MUST ignore offers anywhere else.
- **Greeting.** The caller's server fetches what to play with a signed `/greeting` (`to` = the
  person, or the phone through its allow-list). The callee's server answers only with an active
  connection (a phone: `from` on its allow-list): the recording with `olp-greeting: name|custom`,
  or `204` for the spoken default, built from the offer's `name`.
- **Message.** The caller's server delivers the recording with a signed
  `/voicemail?to=&from=&fromId=&name=&durationMs=` (`kind=person` for a person; `via` when a
  kids' phone called through its guardian). The callee's server re-checks the connection (and
  the phone's allow-list) at delivery, stores it, and tells its person or the phone's
  guardians. `durationMs` is capped at 120000; recordings are at most 2 MiB of `audio/*`.
- **Relayed offers.** When an offer crosses servers (the two exceptions), the receiving server
  gives its own client an offer of its own whose ticket forwards to the issuing server's
  public ticket endpoints, which are part of this protocol:
  - `GET https://<issuer>/api/vm/greeting?ticket=<ticket>` → greeting audio with
    `olp-greeting: name|custom`, or `204` for the default; `404` for an unknown or used ticket;
  - `POST https://<issuer>/api/vm/message?ticket=<ticket>&durationMs=<ms>` with the raw
    `audio/*` body → `201`, `403` (no longer allowed), `404` (unknown or used), `429` (the
    sender's fair-use allowance).

  Tickets are bearer credentials: single use, valid 10 minutes. A relaying server MUST send a
  ticket only to the server that issued it and MUST NOT log it.

### 8.5 Lounge guests

A Lounge phone's space may let people from other servers use it (off by default).

1. The guest scans the phone's code on server **L**, gives their own address `alice@H`, and
   continues on their own server **H**, which asks them to confirm.
2. **H vouches** with a signed `/lounge/claim {from, deviceId, nonce, directory}`: `from` is the
   guest's own account, `nonce` the single-use code from the phone, `directory` their
   speed-dial (at most 10 of their connections, as addresses). H records that it vouched.
3. **L** refuses unless the space allows guests, the nonce is current and unused, and the
   phone is free; then the phone asks for the same key press as for a member. L reports
   progress to H with `/lounge/progress` (`press_key`, `started`, `failed` + reason, `ended` +
   reason). H MUST ignore progress for sessions it didn't vouch for.
4. **Dialing.** A key press on the phone sends `/lounge/dial {callId, for, deviceId,
   deviceLabel, to}` to H. **H places the call as its account** — its own rules and
   connections — and relays between the two legs (each leg has its own call id). H MUST answer
   `denied` unless it has a live vouched session for `for` at that phone of L and `to` is one of
   `for`'s active connections. An `ended` answer MAY carry H's voicemail offer, which L relays
   (§8.4).
5. **Calls to the guest** ring the phone too: H sends `/calls` with target
   `{kind: "guest", deviceId}`; L MUST accept it only from the server that vouched for the
   guest currently at that phone, and only for that account (`from.id`).
6. The session ends by logging out, `/lounge/leave` from the guest's own app through H, idle,
   a new takeover, or the phone going offline; L sends `ended` progress.

L learns the guest's address and name only. H stays the authority for who the guest may call.

### 8.6 Rooms

- A phone room has an address like a person, `standup@host`. A person on another server joins
  from their own server, which checks its own rules, registers a **leg** id on the stream and
  sends `/rooms/join {leg, from, room}`.
- The room's server decides alone: the room must be open to connections and `from` must have
  an active connection with the room's owner (people in the room's own space are always
  eligible), then the lock and the size. It answers `{ok: true, roomId, name}` or
  `{ok: false, reason}` (`denied`, `locked`, `full`, `unreachable`, `busy`, `error`).
- Afterwards every room message travels as `room.signal {callId: <leg>, msg}` in both
  directions: `room.state`, `room.media`, `room.idle`, `room.ended` to the participant;
  `room.leave`, `room.mute`, `room.talk`, `room.here`, `room.media` and a mesh room's `rtc.*`
  (with `peer`) from them. The route ends with `room.ended` or `room.leave`.
- Each person's own server hands them its own ICE servers. A room's media goes through the room
  owner's server's relay (SFU) or a peer-to-peer mesh (up to 4 people); relayed rooms are
  encrypted in transit, not end to end. Each person's own server meters their minutes; the room's
  server MAY also count remote participants against the room's owner.

### 8.7 Transfers

- Only a **team or org space** may transfer someone from another household or server, and only
  to its own members, phones (never a kids' phone), ring groups and extensions. A home never
  transfers a remote party; targets outside the space are refused.
- **Blind:** the transferring server rings the target under a new call id `N`, registers `N` on
  the stream, and sends the other side `call.state ended` (reason `hangup`) for the old call with
  `transfer {callId: N, ringing: true, offerer: true}`. **Attended:** the same, with
  `ringing: false` (the new call connects at once).
- The receiving server re-checks its own side. A **kids' phone never follows**: its server
  just ends the old call. Otherwise it opens its own successor call for its person (or relays
  the notice on to the server or household its person is in) and tells its client the same way.
  `offerer: true` means its person places the new call (sends the SDP offer).
- The old route stays open until the other side follows or ends it; if the receiver ends the old
  call instead of following, the sender MUST end `N`.
- **Unanswered:** if nobody answers `N`, the transferring server sends `call.state ended` for `N`
  with **its own voicemail offer** (the ring group's shared box, or the member's), exactly as a
  caller from its own space would get; the receiving server relays it to its person (§8.4).

### 8.8 Recording

- A space may record its calls (opt-in, announced to everyone). The caller's server MUST set
  `recording: true` on `/calls` when its space records the call. A server MAY refuse recorded
  calls for its people: it answers `ended` + `denied` with `note` "This server doesn't take
  recorded calls" (or ends a call when a recording is announced later).
- When recording starts (once the call is active), the recording side's server sends
  `call.state active` with `recording: {by: <space name>}` on the stream. It MUST NOT include a
  `ticket` — the recording is made by the recording side's own client. The receiving server
  announces it to its person (prompt and light) or ends the call if it refuses recordings.
- Calls with a kids' phone on either side are never recorded: a caller's server MUST NOT set
  `recording` for calls placed through `viaPhone` or to a household phone, and a receiving
  server MUST NOT record calls from `viaPhone`.

## 9. Versioning and compatibility

- The federation version is an integer, advertised as `version` in `.well-known`, and the base
  path carries it: version 1 is `/fed/v1`, the stream statement is prefixed `olp-stream-v1`.
- **Additive changes keep the version:** new optional request or response fields, new
  endpoints, new optional headers, new `.well-known` fields. Therefore receivers and senders
  MUST ignore unknown object fields, and senders MUST handle `404` on an endpoint a peer doesn't
  have (treat it as "not supported", not as a failure of the whole connection).
- **Everything else is breaking** and needs version 2: removing or renaming a field, making an
  optional field required, changing a field's meaning, type or limits in a narrowing way, new
  values in a closed enum (e.g. call end reasons, room-join reasons, Lounge steps — v1
  implementations validate these strictly), a different signature profile, or a different
  stream handshake.
- **How v2 would coexist:** a server that speaks v2 serves `/fed/v2/*` and keeps `/fed/v1/*`
  unchanged for at least 12 months. Its `.well-known` keeps `"federation": "/fed/v1"` (for v1
  peers) and adds `"version": 2` plus `"versions": {"1": "/fed/v1", "2": "/fed/v2"}`. A peer
  uses the highest version both advertise, per request; a v1-only peer ignores the unknown
  fields and keeps talking v1. The server-pair stream is per version (`/fed/v2/stream`,
  `olp-stream-v2`). Because `@target-uri` is signed, a request signed for one version can't be
  replayed against the other. Keys and pins are shared across versions.
- Device and app messages carried inside signals (`call.state`, `rtc.*`, `room.*`) follow the
  device protocol's own versioning ([protocol.md](protocol.md), `PROTOCOL_VERSION`); additive
  fields there are additive here.

## 10. Security considerations

### 10.1 Transport and first contact

All federation traffic MUST use HTTPS/WSS with certificate validation (loopback hosts excepted).
Trust on first use means an attacker who can impersonate a server's TLS name at the very first
contact could get the wrong key pinned; after that, a changed key is refused and surfaced to the
operator. Operators who know each other MAY compare `server_key` values out of band.

### 10.2 Key compromise and loss

A stolen private key lets the thief speak for every account on that server to every peer, until
peers stop trusting it. There is no revocation in v1: the victim rotates (§3.2, which the thief
could also do) and peers' operators re-pin by hand. Keep the key offline-backed-up and
secret; losing it without a rotation breaks all pins.

### 10.3 Replay and binding

`created` (±300 s) plus single-use nonces stop replays; nonces are consumed only by valid
signatures. `@target-uri` binds a signature to one receiver, path, query and version; the
receiver MUST use its configured public origin to rebuild it, never proxy headers.
`content-digest` binds the body. Stream `hello` frames are bound to both hosts and a fresh
nonce, and `hello.ok` echoes the dialer's nonce, so each side proves it holds its key.

### 10.4 Server-side request forgery

Addresses are typed by people (`x@some.host`) and `keyid`s arrive from anyone, so a server
must never let them point it into its own network. A server with a public name MUST NOT contact
(knocks, key fetches, streams, ticket relays) loopback names, IP literals, single-label names or
local-network suffixes (`.local`, `.internal`, `.lan`, `.home.arpa`, `.localdomain`); a
development server on a loopback name may talk to other loopback servers. DNS can still resolve
a public name to a private address: self-hosted operators SHOULD also filter outbound traffic
(Cloudflare Workers can't reach private networks).

### 10.5 Privacy and enumeration

Knocks always answer `202`, authorization failures always say `denied`, and there is no
directory, so accounts can't be listed or probed. Presence, names and shared phones go only to
active connections. Call audio is peer to peer (or through the parties' own TURN) and never
passes through a server; relayed room audio passes through the room owner's relay (encrypted in
transit, not end to end). Recordings are opt-in per space and always announced to every party,
on every server.

### 10.6 Abuse and denial of service

Budgets per sending server (§5) and per account, bounded bodies (16 KiB JSON, 2 MiB audio,
16 KiB stream frames), one stream per server pair that the dialer closes when idle, and
operator blocklists (a person, a household, or a whole server) keep any one server from
exhausting another. Budgets are equal for every server.

### 10.7 Trust boundaries

A server only speaks for its own accounts: the `keyid` host is the authority for every `from`,
and a receiver MUST bind `from` to that host. Everything that protects a person — connections,
allow-lists, quiet hours, blocks, recording refusal, a kids' phone never following a transfer —
is enforced by that person's own server, whatever the other server claims. Lounge guest
assertions are accepted only from the guest's own server and only for the phone it vouched at.
Voicemail tickets are bearer tokens: single use, 10 minutes, forwarded only to their issuer.

## 11. Implementation notes

- **Reference implementation:** `packages/federation` (signatures, keys, schemas, this spec's
  generated parts) and `packages/server-app` (`federation.ts`, `fedStream.ts`, `fedCalls.ts`,
  `connections.ts`). Interop tests: `tests/e2e/twoServers.test.ts` (two self-hosted servers)
  and `tests/e2e/cloudflare.test.ts` (two Workers), both run in CI.
- **Key rotation:** the reference server accepts peers' rotations (§3.2) but has no tool to
  rotate its own key yet, so it never publishes `previous_key`. Rejected key changes are shown
  to operators (`keyAlerts`); re-pinning is a manual database change for now.
- **Same server, several households:** calls between households on one server use the same
  code paths with host `''` and direct hub-to-hub delivery instead of HTTP and the stream; that
  is internal and not part of this protocol.
