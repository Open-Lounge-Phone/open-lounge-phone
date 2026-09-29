// Every `/fed/v1` endpoint with its request and response schemas: the machine-readable half of
// docs/federation-spec.md (its endpoint section is generated from this list; see spec.ts).
import type { z } from "zod";
import {
  AcceptBody,
  Accepted,
  CallBody,
  CallResult,
  GreetingBody,
  KnockBody,
  LoungeClaimBody,
  LoungeClaimResult,
  LoungeDialBody,
  LoungeLeaveBody,
  LoungeProgressBody,
  PhonesBody,
  PresenceBody,
  RemoveBody,
  RoomJoinBody,
  RoomJoinResult,
  StreamQuery,
  VoicemailQuery,
} from "./messages.ts";
import { WellKnown } from "./wellKnown.ts";

export interface FedResponse {
  status: number;
  /** JSON body schema; absent for an empty or non-JSON body (see `note`). */
  schema?: z.ZodType;
  note: string;
}

export interface FedEndpoint {
  method: "GET" | "POST";
  /** Absolute path on the receiving server. */
  path: string;
  /** Whether the request carries an RFC 9421 signature (everything under /fed/v1 except the stream, which signs in-band). */
  signed: boolean;
  summary: string;
  body?: z.ZodType;
  /** For bodies that aren't JSON. */
  bodyNote?: string;
  query?: z.ZodType;
  responses: FedResponse[];
  /** Normative rules for the receiver beyond the schema. */
  rules: string[];
}

const accepted = (note: string): FedResponse => ({ status: 202, schema: Accepted, note });

export const FED_ENDPOINTS: FedEndpoint[] = [
  {
    method: "GET",
    path: "/.well-known/openloungephone",
    signed: false,
    summary: "Discovery: the server's federation key and where `/fed/v1` lives.",
    responses: [
      { status: 200, schema: WellKnown, note: "Cacheable for up to 300 s." },
      { status: 404, note: "The server does not federate." },
    ],
    rules: [
      "Served over HTTPS (plain HTTP only for `localhost` and `*.localhost`).",
      "`server_key` is the raw 32-byte Ed25519 public key, base64url without padding.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/knock",
    signed: true,
    summary: "A contact request from `from` to `to`.",
    body: KnockBody,
    responses: [
      accepted(
        "Always, whether or not the handle exists, the sender is blocked, cooling down or already pending.",
      ),
      { status: 429, note: "The sending server exceeded its daily knock budget (`Retry-After`)." },
    ],
    rules: [
      "MUST NOT reveal whether `to` exists: unknown handles, blocks, cooldowns and duplicates all answer 202.",
      "Knocking back someone who knocked you connects both (the receiver sends `/connections/accept`).",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/connections/accept",
    signed: true,
    summary: "`from` accepts the knock that `to` sent them.",
    body: AcceptBody,
    responses: [accepted("Always; ignored unless `to` has a pending knock to `from`.")],
    rules: ["Both sides' rows become `active`; calls are allowed only from now on."],
  },
  {
    method: "POST",
    path: "/fed/v1/connections/remove",
    signed: true,
    summary: "`from` disconnected from `to`, cancelled a knock, or blocked `to`.",
    body: RemoveBody,
    responses: [accepted("Always.")],
    rules: [
      "The receiver drops its row for the pair (keeping its own blocks and declines) and any phone allow-list entries made through it.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/calls",
    signed: true,
    summary: "Ring someone on the receiving server for `from`.",
    body: CallBody,
    responses: [
      {
        status: 200,
        schema: CallResult,
        note: "`ringing`, or `ended` with a reason; never a `voicemail` offer (that is the caller's server's to make).",
      },
    ],
    rules: [
      "Decided by the receiver alone: an active connection with `from` by stable id (for a phone, an allow-list entry through such a connection with `canCallDevice`), no block of the person or server, then quiet hours (`voicemail`), reachability, availability and busy.",
      "`guest` targets are accepted only from the server that vouched for that guest at that Lounge phone.",
      "Signaling for `callId` then travels on the server-pair stream.",
    ],
  },
  {
    method: "GET",
    path: "/fed/v1/stream",
    signed: false,
    summary: "WebSocket upgrade: the server-pair stream, authenticated in-band by `hello`.",
    query: StreamQuery,
    responses: [
      { status: 101, note: "Switching protocols; the dialer's first frame MUST be `hello`." },
      { status: 400, note: "`from` is not a host name." },
    ],
    rules: ["See [the stream](#6-the-server-pair-stream)."],
  },
  {
    method: "POST",
    path: "/fed/v1/voicemail",
    signed: true,
    summary: "A voicemail message for a phone here, or with `kind=person` for a person here.",
    query: VoicemailQuery,
    bodyNote:
      "The raw recording (`Content-Type: audio/*`), at most 2 MiB; `Content-Digest` covers it.",
    responses: [
      { status: 201, schema: Accepted, note: "Stored (and transcribed if the server does that)." },
      {
        status: 403,
        note: "No active connection with the sender (a phone: the sender isn't on its allow-list).",
      },
      { status: 400, note: "Invalid sender fields or an empty body." },
      { status: 413, note: "Larger than 2 MiB." },
      { status: 415, note: "Not `audio/*`." },
    ],
    rules: [
      "The sender is `from`/`fromId`/`name` on the *signing* server; the receiver re-checks the connection (and allow-list) at delivery time.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/greeting",
    signed: true,
    summary: "The greeting to play before `from` leaves a message for `to`.",
    body: GreetingBody,
    responses: [
      {
        status: 200,
        note: "The audio (`Content-Type: audio/*`) with header `olp-greeting: name|custom`.",
      },
      { status: 204, note: "Use the spoken default greeting (`olp-greeting: default`)." },
      { status: 403, note: "No active connection (a phone: `from` not on its allow-list)." },
    ],
    rules: ["Not cached by the caller's server beyond the one voicemail it serves."],
  },
  {
    method: "POST",
    path: "/fed/v1/phones",
    signed: true,
    summary: "The household phones `to` may call through their connection with `from`.",
    body: PhonesBody,
    responses: [accepted("Always.")],
    rules: ["Replaces the previous list for that connection; an empty list clears it."],
  },
  {
    method: "POST",
    path: "/fed/v1/presence",
    signed: true,
    summary: "`from`'s availability, for their connections on the receiving server (opt-in).",
    body: PresenceBody,
    responses: [accepted("Always; entries in `to` without an active connection are ignored.")],
    rules: [
      "Sent only while `from` opted in; batched per receiving server; at most 5 per person per 10 s (later changes coalesce to the latest state).",
      "Receivers treat presence older than an hour as unknown.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/lounge/claim",
    signed: true,
    summary: "The sender vouches that its account `from` scanned the receiver's Lounge phone.",
    body: LoungeClaimBody,
    responses: [{ status: 200, schema: LoungeClaimResult, note: "Next step, or why not." }],
    rules: [
      "Refused (`not_found`) unless the phone's space lets people from other servers use it.",
      "The single-use `nonce` from the phone's code must match; then the phone asks for the same key press as for a member.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/lounge/progress",
    signed: true,
    summary: "The receiver's account's takeover of the sender's Lounge phone moved on.",
    body: LoungeProgressBody,
    responses: [accepted("Always; ignored unless the receiver vouched for `to` at that phone.")],
    rules: [],
  },
  {
    method: "POST",
    path: "/fed/v1/lounge/dial",
    signed: true,
    summary:
      "A guest (the receiver's account `for`) pressed a key on the sender's Lounge phone; the receiver places the call as them.",
    body: LoungeDialBody,
    responses: [
      {
        status: 200,
        schema: CallResult,
        note: "Like `/calls`; an `ended` answer may carry the guest's server's `voicemail` offer.",
      },
    ],
    rules: [
      "Refused (`denied`) unless the receiver has a live vouched session for `for` at `deviceId` on the sender, and `to` is one of `for`'s active connections.",
    ],
  },
  {
    method: "POST",
    path: "/fed/v1/lounge/leave",
    signed: true,
    summary: "`from` leaves the receiver's Lounge phone (from their own app).",
    body: LoungeLeaveBody,
    responses: [accepted("Always.")],
    rules: [],
  },
  {
    method: "POST",
    path: "/fed/v1/rooms/join",
    signed: true,
    summary: "`from` asks into the phone room `room@<receiver>`; `leg` names their side.",
    body: RoomJoinBody,
    responses: [{ status: 200, schema: RoomJoinResult, note: "Admitted, or why not." }],
    rules: [
      "Decided by the room's server: open to connections and `from` connected with the room's owner, then the lock and the size.",
      "Everything after admission travels as `room.signal` on the stream, keyed by `leg`.",
    ],
  },
];
