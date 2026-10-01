// Bodies of the signed `/fed/v1` requests. The sending server is the signature's key id; every
// `from` is one of that server's accounts, so a server can only speak for its own people.
import {
  CallStateMsg,
  RoomEnded,
  RoomHere,
  RoomIdle,
  RoomLeave,
  RoomLock,
  RoomMediaMsg,
  RoomMute,
  RoomRemove,
  RoomState,
  RoomTalk,
  RtcIce,
  RtcSdp,
  VoicemailOffer,
} from "@openloungephone/protocol";
import { z } from "zod";
import { HANDLE_RE } from "./address.ts";

export const Handle = z.string().regex(HANDLE_RE);
const Id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** One person on the sending server: current handle, stable id, display name. */
export const Party = z
  .object({
    handle: Handle.describe("Current handle on the sending server (may change)."),
    id: Id.describe("Stable account id on the sending server (never changes)."),
    name: z.string().trim().min(1).max(64).describe("Display name."),
  })
  .describe("One of the sending server's accounts.");
export type Party = z.infer<typeof Party>;

export const Note = z.string().trim().max(140);

/** `POST /fed/v1/knock`: a contact request. Always answered 202, whatever happens to it. */
export const KnockBody = z.object({
  from: Party,
  to: Handle.describe("A handle on the receiving server."),
  note: Note.optional().describe("A short note shown with the request."),
});
/** `POST /fed/v1/connections/accept`: `from` accepts the knock `to` sent them. */
export const AcceptBody = z.object({
  from: Party,
  to: Handle.describe("The handle (on the receiving server) whose knock `from` accepts."),
});
/** `POST /fed/v1/connections/remove`: `from` disconnected, cancelled a knock, or blocked. */
export const RemoveBody = z.object({
  from: Party,
  to: Handle.describe("The handle (on the receiving server) `from` disconnects from."),
});

export type KnockBody = z.infer<typeof KnockBody>;
export type AcceptBody = z.infer<typeof AcceptBody>;
export type RemoveBody = z.infer<typeof RemoveBody>;

/** Largest JSON body accepted on `/fed/v1` (voicemail audio has its own limit). */
export const MAX_FED_BODY_BYTES = 16 * 1024;
/** Largest voicemail recording accepted on `/fed/v1/voicemail` (raw audio). */
export const MAX_FED_VOICEMAIL_BYTES = 2 * 1024 * 1024;

/** The answer to requests whose outcome is not the sender's business (`202`). */
export const Accepted = z.object({ ok: z.literal(true) });
/** Every refusal on `/fed/v1` (4xx/5xx): a short, human-readable reason. */
export const FedErrorBody = z.object({ error: z.string().max(200) });

// --- F2: calls, presence, shared phones, Lounge guests ------------------------------------

export const CallTarget = z.discriminatedUnion("kind", [
  /** A person: rings their app sessions and own phones. */
  z.object({ kind: z.literal("person"), handle: Handle }),
  /** A household phone whose allow-list lists `from` (see `/fed/v1/phones`). */
  z.object({ kind: z.literal("phone"), deviceId: Id }),
  /**
   * The receiving server's Lounge phone where `from` (the sender's own account) is a guest right
   * now: the guest's server rings them there too. Only for the server that vouched for them.
   */
  z.object({ kind: z.literal("guest"), deviceId: Id }),
]);
export type CallTarget = z.infer<typeof CallTarget>;

/**
 * `POST /fed/v1/calls`: `from` calls someone here. `callId` is chosen by the caller's server and
 * names the call on both servers. The callee's server decides everything about its own side.
 */
export const CallBody = z.object({
  callId: Id.describe("Chosen by the caller's server; names the call on both servers."),
  from: Party,
  to: CallTarget,
  /** A household phone is calling through `from`'s connection (e.g. a kid's phone). */
  viaPhone: z
    .object({ label: z.string().trim().min(1).max(24) })
    .optional()
    .describe("A household phone (e.g. a kid's) calls through `from`'s connection."),
  /** `from` is at one of the sending server's Lounge phones as a guest from `guestOf`. */
  guestOf: z
    .string()
    .max(260)
    .optional()
    .describe("`from` is a guest at one of the sender's Lounge phones, from this host."),
  /** What to show while ringing, when it isn't `from` (a guest's phone rung for their caller). */
  ringLabel: z
    .string()
    .trim()
    .min(1)
    .max(24)
    .optional()
    .describe("What to show while ringing, when it isn't `from.name`."),
  /**
   * The caller's space records this call (announced to everyone once it's answered). A server
   * may refuse recorded calls for its people: it answers `ended` `denied` with a `note`.
   */
  recording: z
    .boolean()
    .optional()
    .describe("The caller's space records this call; the receiver may refuse (`denied` + `note`)."),
});
export type CallBody = z.infer<typeof CallBody>;

export const CallEndReason = z.enum([
  "hangup",
  "declined",
  "busy",
  "denied",
  "voicemail",
  "timeout",
  "unreachable",
  "unavailable",
  "error",
]);

/** Answer to `/fed/v1/calls`: ringing now, or refused with a reason. */
export const CallResult = z.union([
  z.object({ state: z.literal("ringing") }),
  z.object({
    state: z.literal("ended"),
    reason: CallEndReason,
    /** The refusing server's explanation, e.g. that it doesn't take recorded calls. */
    note: z.string().max(200).optional(),
    /**
     * `/fed/v1/lounge/dial` only: the guest's call can't ring through; their server's voicemail
     * offer, for the Lounge phone to play and record (see `/api/vm/*` on the guest's server).
     */
    voicemail: VoicemailOffer.optional(),
  }),
]);
export type CallResult = z.infer<typeof CallResult>;

/** `POST /fed/v1/presence`: `from`'s availability, for their connections here (opt-in, batched). */
export const PresenceBody = z.object({
  from: Party,
  to: z
    .array(Handle)
    .min(1)
    .max(200)
    .describe("`from`'s active connections on the receiving server (one request per server)."),
  online: z.boolean().describe("Has a live app session or phone."),
  available: z.boolean().describe("Takes calls right now (their own availability switch)."),
});
export type PresenceBody = z.infer<typeof PresenceBody>;

/**
 * `POST /fed/v1/phones`: the household phones `to` may call through their connection with
 * `from` (a guardian here listed them on those phones' allow-lists). Replaces the earlier list.
 */
export const PhonesBody = z.object({
  from: Party,
  to: Handle,
  phones: z.array(z.object({ id: Id, label: z.string().trim().min(1).max(24) })).max(16),
});
export type PhonesBody = z.infer<typeof PhonesBody>;

/**
 * `POST /fed/v1/lounge/claim`: the sending server vouches that `from` (its account) scanned this
 * server's Lounge phone; `directory` is their speed-dial there (their connections).
 */
export const LoungeClaimBody = z.object({
  from: Party,
  deviceId: Id,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  directory: z
    .array(z.object({ address: z.string().max(300), name: z.string().trim().min(1).max(64) }))
    .max(10),
});
export type LoungeClaimBody = z.infer<typeof LoungeClaimBody>;

/** Answer to `/fed/v1/lounge/claim`. */
export const LoungeClaimResult = z.union([
  z.object({
    step: z.literal("press_key"),
    expiresAt: z.number().int().describe("Epoch ms: the guest must press the key before this."),
  }),
  z.object({
    step: z.literal("failed"),
    reason: z.enum(["expired", "wrong_key", "timeout", "busy", "not_found"]),
  }),
]);
export type LoungeClaimResult = z.infer<typeof LoungeClaimResult>;

export const LoungeStep = z.enum(["press_key", "started", "failed", "ended"]);

/** `POST /fed/v1/lounge/progress`: a guest's takeover here moved on (to their home server). */
export const LoungeProgressBody = z.object({
  to: Handle,
  deviceId: Id,
  step: LoungeStep,
  reason: z.string().max(32).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});
export type LoungeProgressBody = z.infer<typeof LoungeProgressBody>;

/**
 * `POST /fed/v1/lounge/dial`: a guest from the receiving server pressed a key on the sending
 * server's Lounge phone. The receiving server places the call as its own account `for` (only
 * while it has a live Lounge session there), with the phone as the far end (`callId`).
 */
export const LoungeDialBody = z.object({
  callId: Id,
  for: Handle,
  deviceId: Id,
  deviceLabel: z.string().trim().min(1).max(24),
  /** An address from the directory the guest's server sent with the claim. */
  to: z.string().max(300),
});
export type LoungeDialBody = z.infer<typeof LoungeDialBody>;

// --- the server-pair stream (`GET /fed/v1/stream?from=<host>`, WebSocket) --------------------

/** What each side signs to open the stream (the dialer first, the acceptor echoing its nonce). */
export const streamStatement = (from: string, to: string, created: number, nonce: string) =>
  `olp-stream-v1\n${from}\n${to}\n${created}\n${nonce}`;

const Host = z.string().min(1).max(260);
export const StreamHello = z.object({
  t: z.enum(["hello", "hello.ok"]),
  from: Host.describe("The sender of this frame (host, with port if any)."),
  to: Host.describe("The other end (host, with port if any)."),
  created: z.number().int().describe("Unix time in seconds."),
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .describe("The dialer's random nonce; `hello.ok` echoes it."),
  sig: z
    .string()
    .max(128)
    .describe("base64url Ed25519 signature over `streamStatement(from, to, created, nonce)`."),
});
export type StreamHello = z.infer<typeof StreamHello>;

/**
 * `POST /fed/v1/greeting`: `from`'s call to `to` went to voicemail; fetch the greeting to play.
 * Only with an active connection (a phone: `from` on its allow-list). Answered with the audio
 * (header `olp-greeting: name|custom`) or 204 for the spoken default greeting.
 */
export const GreetingBody = z.object({
  from: Party,
  to: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("person"), handle: Handle }),
    z.object({ kind: z.literal("phone"), deviceId: Id }),
  ]),
});
export type GreetingBody = z.infer<typeof GreetingBody>;

/**
 * Query of `POST /fed/v1/voicemail` (the body is the raw `audio/*` recording). Without `kind` the
 * message is for the household phone `to`; with `kind=person`, for the person `to` (a handle).
 */
export const VoicemailQuery = z.object({
  to: z.string().min(1).max(64).describe("A phone's device id, or with `kind=person` a handle."),
  kind: z.literal("person").optional(),
  from: Handle.describe("The sender's handle on the sending server."),
  fromId: Id.describe("The sender's stable account id."),
  name: z.string().trim().min(1).max(64).describe("The sender's display name."),
  durationMs: z
    .string()
    .regex(/^\d{1,7}$/)
    .describe("Length in ms (capped at 120000)."),
  via: z
    .string()
    .max(24)
    .optional()
    .describe("With `kind=person`: the sender's kids' phone that called, through its guardian."),
});
export type VoicemailQuery = z.infer<typeof VoicemailQuery>;

/** Query of `GET /fed/v1/stream` (a WebSocket upgrade). */
export const StreamQuery = z.object({
  from: z.string().min(1).max(260).describe("The dialing server's host (checked by `hello`)."),
});

/** `POST /fed/v1/lounge/leave`: `from` leaves the receiving server's Lounge phone. */
export const LoungeLeaveBody = z.object({ from: Party, deviceId: Id });

/**
 * A room message between a participant's server (which holds their "room leg") and the room's
 * server, both ways, in the same shapes as clients use. `callId` is the leg's id.
 */
export const RoomSignalMsg = z.union([
  RoomState,
  RoomMediaMsg,
  RoomIdle,
  RoomEnded,
  RoomLeave,
  RoomMute,
  RoomRemove,
  RoomLock,
  RoomTalk,
  RoomHere,
  RtcSdp,
  RtcIce,
]);
export type RoomSignalMsg = z.infer<typeof RoomSignalMsg>;
export const RoomSignal = z.object({ t: z.literal("room.signal"), callId: Id, msg: RoomSignalMsg });
export type RoomSignal = z.infer<typeof RoomSignal>;

/**
 * `POST /fed/v1/rooms/join`: `from` wants into the phone room `room` (a handle here). `leg`
 * names their side; the room's server decides (its space, or an active connection with the
 * room's owner, then lock and size) and answers `{ok: true, roomId}` or `{ok: false, reason}`.
 * Everything after that travels as `room.signal` on the server-pair stream.
 */
export const RoomJoinBody = z.object({ leg: Id, from: Party, room: Handle });
export type RoomJoinBody = z.infer<typeof RoomJoinBody>;
export const RoomJoinResult = z.union([
  z.object({ ok: z.literal(true), roomId: Id, name: z.string().max(64) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["denied", "locked", "full", "unreachable", "busy", "error"]),
    note: z.string().max(200).optional(),
  }),
]);
export type RoomJoinResult = z.infer<typeof RoomJoinResult>;

/** Call signaling relayed between the two servers of a federated call (same shapes as clients). */
export const FedSignal = z.discriminatedUnion("t", [CallStateMsg, RtcSdp, RtcIce, RoomSignal]);
export type FedSignal = z.infer<typeof FedSignal>;
export const StreamSignal = z.object({ t: z.literal("signal"), msg: FedSignal });

/**
 * The answer to a frame (or a `signal` whose `msg.t`) the receiver doesn't know: the stream stays
 * open. Never answered itself, so two servers can't loop.
 */
export const StreamUnsupported = z.object({
  t: z.literal("unsupported"),
  type: z.string().max(64).describe("The frame's `t`, or `signal:<msg.t>` for a signal."),
  callId: Id.optional().describe("The signal's `callId`, when it had one."),
});
export type StreamUnsupported = z.infer<typeof StreamUnsupported>;
