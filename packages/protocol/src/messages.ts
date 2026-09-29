import { z } from "zod";
import { Base64Url, CallState, EndReason, EpochMs, ErrorCode, IceServer, Id } from "./common.ts";

// Every message is a flat JSON object discriminated by `t`. An optional `id` lets a sender
// correlate an `error` reply with the message that caused it.
const Ref = { id: Id.optional() };

// ---------------------------------------------------------------------------
// Shared between devices and companion apps: call control and WebRTC signaling.
// ---------------------------------------------------------------------------

export const CallAnswer = z
  .object({ t: z.literal("call.answer"), ...Ref, callId: Id })
  .describe("Accept an incoming call.");

export const CallHangup = z
  .object({ t: z.literal("call.hangup"), ...Ref, callId: Id })
  .describe("Leave (or decline) a call.");

export const RtcSdp = z
  .object({
    t: z.literal("rtc.sdp"),
    ...Ref,
    callId: Id,
    type: z.enum(["offer", "answer"]),
    sdp: z.string().min(1),
  })
  .describe("SDP offer/answer. Relayed to the peer (p2p) or to the SFU (cloudflare-realtime).");

export const RtcIce = z
  .object({
    t: z.literal("rtc.ice"),
    ...Ref,
    callId: Id,
    candidate: z.string().nullable().describe("null signals end-of-candidates."),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
  })
  .describe("Trickled ICE candidate.");

export const Ping = z.object({ t: z.literal("ping"), ...Ref }).describe("Keep-alive.");

// ---------------------------------------------------------------------------
// Device -> server
// ---------------------------------------------------------------------------

export const DeviceModel = z.enum(["web-emulator", "desktop", "esp32s3"]);

export const DeviceHello = z
  .object({
    t: z.literal("hello"),
    ...Ref,
    proto: z.number().int().positive(),
    deviceId: Id.optional().describe("Omitted by an unpaired device."),
    model: DeviceModel,
    fw: z.string().min(1).max(32).describe("Firmware / emulator version."),
    buttons: z.number().int().min(1).max(16).describe("Number of speed-dial buttons."),
    display: z
      .enum(["eink", "seg14", "oled", "none"])
      .describe(
        "Status display fitted: `eink` strip (standard), `seg14`/`oled` I2C modules (cheaper option), `none` (Kids Lite: printed key labels, LEDs and voice).",
      ),
  })
  .describe("First message on every connection.");

export const KeyAlg = z
  .enum(["ed25519", "p256"])
  .describe("`p256` = ECDSA P-256/SHA-256 for hardware whose secure key storage lacks Ed25519.");
export type KeyAlg = z.infer<typeof KeyAlg>;

/** base64url lengths of a raw public key per algorithm (32-byte Ed25519, 65-byte SEC1 P-256). */
export const PUBLIC_KEY_LENGTH: Record<KeyAlg, number> = { ed25519: 43, p256: 87 };

export const PhoneKind = z
  .enum(["kids", "lounge"])
  .describe(
    "`kids` = a household phone with its own allow-list; `lounge` = a shared phone people take over with the companion app.",
  );
export type PhoneKind = z.infer<typeof PhoneKind>;

export const PairBegin = z
  .object({
    t: z.literal("pair.begin"),
    ...Ref,
    alg: KeyAlg.optional().describe("Defaults to `ed25519`."),
    kind: PhoneKind.optional().describe(
      "What the phone was set up as (first-run choice); the guardian can override it when pairing. Defaults to `kids`.",
    ),
    publicKey: Base64Url.describe(
      "Raw public key, base64url: Ed25519 32 bytes, or P-256 uncompressed SEC1 point 65 bytes.",
    ),
  })
  .refine((m) => m.publicKey.length === PUBLIC_KEY_LENGTH[m.alg ?? "ed25519"], {
    message: "publicKey length does not match alg",
    path: ["publicKey"],
  })
  .describe("Unpaired device asks for a pairing code to show on its display.");

export const AuthProof = z
  .object({
    t: z.literal("auth.proof"),
    ...Ref,
    sig: Base64Url.length(86).describe(
      "Signature over the raw nonce bytes: Ed25519 (64 bytes) or P-256 ECDSA/SHA-256 as r‖s (64 bytes).",
    ),
  })
  .describe("Answer to `auth.challenge`.");

export const Hook = z
  .object({ t: z.literal("hook"), ...Ref, state: z.enum(["up", "down"]) })
  .describe("Handset lifted (`up`) or returned to the cradle (`down`).");

export const Button = z
  .object({ t: z.literal("button"), ...Ref, index: z.number().int().min(0).max(15) })
  .describe("Speed-dial button pressed (0-based).");

export const PowerStatus = z
  .object({
    source: z
      .enum(["default", "1.5A", "3A"])
      .describe("Current the USB-C source advertises (USB-A chargers always read `default`)."),
    reduced: z.boolean().describe("Running with features limited because the source is too weak."),
  })
  .describe("USB power source; the Lounge phone needs a ≥1.5 A source for full features.");

export const Status = z
  .object({
    t: z.literal("status"),
    ...Ref,
    battery: z.object({ pct: z.number().int().min(0).max(100), charging: z.boolean() }).optional(),
    rssi: z.number().int().optional().describe("Wi-Fi signal strength in dBm."),
    uptimeS: z.number().int().nonnegative().optional(),
    power: PowerStatus.optional(),
  })
  .describe("Periodic health report, forwarded to guardians.");

export const LoungePress = z
  .object({
    t: z.literal("lounge.press"),
    ...Ref,
    index: z.number().int().min(0).max(15),
  })
  .describe(
    "Lounge phone: a key pressed while `lounge.challenge` is showing (proximity proof), as a button index.",
  );

export const LoungeRefresh = z
  .object({ t: z.literal("lounge.refresh"), ...Ref })
  .describe(
    "Lounge phone: asks for a fresh takeover code (answered with `lounge.idle`). Sent only while the code is on screen and the current one is missing or about to expire, so an unused phone costs the server nothing.",
  );

export const LoungeLeave = z
  .object({ t: z.literal("lounge.leave"), ...Ref })
  .describe("Lounge phone: MENU → Log out. Ends the session; the phone forgets everything.");

export const LoungeChat = z
  .object({ t: z.literal("lounge.chat"), ...Ref, open: z.boolean() })
  .describe('Lounge phone: the person here toggles "open to chat" (ends with the session).');

export const DeviceToServer = z.discriminatedUnion("t", [
  DeviceHello,
  PairBegin,
  AuthProof,
  Hook,
  Button,
  Status,
  LoungePress,
  LoungeRefresh,
  LoungeLeave,
  LoungeChat,
  CallAnswer,
  CallHangup,
  RtcSdp,
  RtcIce,
  Ping,
]);
export type DeviceToServer = z.infer<typeof DeviceToServer>;

// ---------------------------------------------------------------------------
// Server -> device
// ---------------------------------------------------------------------------

export const AuthChallenge = z
  .object({ t: z.literal("auth.challenge"), ...Ref, nonce: Base64Url.min(22) })
  .describe("Paired device must sign `nonce` with its private key.");

export const PairCode = z
  .object({
    t: z.literal("pair.code"),
    ...Ref,
    code: z.string().regex(/^\d{6}$/),
    expiresAt: EpochMs,
  })
  .describe("Code the device displays; a guardian types it into the companion app.");

export const PairDone = z
  .object({ t: z.literal("pair.done"), ...Ref, deviceId: Id, householdId: Id })
  .describe("Pairing succeeded; device persists `deviceId` and reconnects with it.");

export const ButtonConfig = z.object({
  index: z.number().int().min(0).max(15),
  label: z.string().min(1).max(24),
});

export const Config = z
  .object({
    t: z.literal("config"),
    ...Ref,
    buttons: z.array(ButtonConfig).max(16).describe("Only mapped buttons are listed."),
    quiet: z.boolean().describe("Quiet hours currently in effect."),
    quietUntil: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional()
      .describe("Local time (HH:MM) when current quiet hours end, if they end."),
    missed: z
      .array(z.object({ from: z.string().min(1).max(24) }))
      .max(8)
      .optional()
      .describe("Unheard voicemails, newest first, for the status display."),
  })
  .describe("Sent after authentication and whenever guardians change settings.");

export const CallRinging = z
  .object({
    t: z.literal("call.ringing"),
    ...Ref,
    callId: Id,
    from: z.object({ label: z.string().min(1).max(24) }),
  })
  .describe("Incoming call; device rings until answered, hung up, or ended.");

export const CallStateMsg = z
  .object({
    t: z.literal("call.state"),
    ...Ref,
    callId: Id,
    state: CallState,
    reason: EndReason.optional().describe("Present when `state` is `ended`."),
  })
  .describe("Call progress update.");

export const RtcConfig = z
  .object({ t: z.literal("rtc.config"), ...Ref, callId: Id, iceServers: z.array(IceServer) })
  .describe("ICE servers for this call; precedes any `rtc.sdp`.");

export const ErrorMsg = z
  .object({
    t: z.literal("error"),
    ...Ref,
    code: ErrorCode,
    message: z.string().max(256),
    ref: Id.optional().describe("`id` of the message that caused the error."),
  })
  .describe("Request failed. Connection stays open unless `code` is `unauthorized`.");

export const Pong = z.object({ t: z.literal("pong"), ...Ref }).describe("Keep-alive reply.");

export const LoungeIdle = z
  .object({
    t: z.literal("lounge.idle"),
    ...Ref,
    nonce: Base64Url.min(16).max(64),
    expiresAt: EpochMs,
  })
  .describe(
    "Lounge phone: current takeover nonce. Show a QR code for `<server>/lounge#<deviceId>.<nonce>`. Single use; sent on connect, after each use or failed proof, and on `lounge.refresh`. Expired nonces are refused.",
  );

export const LoungeChallenge = z
  .object({
    t: z.literal("lounge.challenge"),
    ...Ref,
    index: z.number().int().min(0).max(15).describe("Button index of the key to flash."),
    expiresAt: EpochMs,
  })
  .describe(
    "Lounge phone: someone scanned the code. Flash this key; they must press it on the phone before `expiresAt`.",
  );

export const LoungeSession = z
  .object({
    t: z.literal("lounge.session"),
    ...Ref,
    name: z.string().min(1).max(24),
    openToChat: z.boolean(),
  })
  .describe(
    'Lounge phone: taken over by `name` (show "Hi <name>"). Their speed-dial arrives as `config`.',
  );

export const LoungeReason = z
  .enum(["logout", "left", "idle", "replaced", "removed", "offline"])
  .describe(
    "`logout` = MENU → Log out on the phone; `left` = Leave in the app; `idle` = idle timeout; `replaced` = a new takeover; `removed` = the person was removed; `offline` = the phone disconnected.",
  );

export const LoungeEnded = z
  .object({ t: z.literal("lounge.ended"), ...Ref, reason: LoungeReason })
  .describe(
    "Lounge phone: the session is over. Forget everything about the person (names, speed-dial, call history) and show the takeover code again.",
  );

export const ServerToDevice = z.discriminatedUnion("t", [
  AuthChallenge,
  PairCode,
  PairDone,
  Config,
  LoungeIdle,
  LoungeChallenge,
  LoungeSession,
  LoungeEnded,
  CallRinging,
  CallStateMsg,
  RtcConfig,
  RtcSdp,
  RtcIce,
  ErrorMsg,
  Pong,
]);
export type ServerToDevice = z.infer<typeof ServerToDevice>;

// ---------------------------------------------------------------------------
// Companion app <-> server. Apps authenticate with a session token obtained over HTTP.
// ---------------------------------------------------------------------------

export const AppHello = z
  .object({
    t: z.literal("app.hello"),
    ...Ref,
    proto: z.number().int().positive(),
    token: z.string().min(16).max(512),
    /** One of the account's households to act in; default: the session's active household. */
    household: Id.optional(),
  })
  .describe("First message from a companion app.");

export const CallDial = z
  .object({ t: z.literal("call.dial"), ...Ref, deviceId: Id })
  .describe("Companion app calls a device.");

export const CallUser = z
  .object({ t: z.literal("call.user"), ...Ref, userId: Id })
  .describe(
    "Companion app calls another member of the same server, app to app. Refused unless they're online and available.",
  );

export const PresenceSet = z
  .object({ t: z.literal("presence.set"), ...Ref, available: z.boolean() })
  .describe("Whether this person is taking app-to-app calls (persisted).");

export const LoungeClaim = z
  .object({
    t: z.literal("lounge.claim"),
    ...Ref,
    deviceId: Id,
    nonce: Base64Url.min(16).max(64),
  })
  .describe(
    "Use a Lounge phone as yourself: `deviceId` and `nonce` from its QR code. The phone then asks for the key proof.",
  );

export const LoungeAppLeave = z
  .object({ t: z.literal("lounge.leave"), ...Ref, deviceId: Id })
  .describe("End your session on a Lounge phone (guardians can end anyone's).");

export const AppToServer = z.discriminatedUnion("t", [
  AppHello,
  CallDial,
  CallUser,
  PresenceSet,
  LoungeClaim,
  LoungeAppLeave,
  CallAnswer,
  CallHangup,
  RtcSdp,
  RtcIce,
  Ping,
]);
export type AppToServer = z.infer<typeof AppToServer>;

export const AppReady = z
  .object({ t: z.literal("app.ready"), ...Ref, userId: Id })
  .describe("Companion app authenticated.");

export const DeviceStatus = z
  .object({
    t: z.literal("device.status"),
    ...Ref,
    deviceId: Id,
    online: z.boolean(),
    battery: Status.shape.battery,
    rssi: Status.shape.rssi,
    power: Status.shape.power,
    lastSeen: EpochMs,
    lounge: z
      .object({ userId: Id, name: z.string().min(1).max(24), since: EpochMs })
      .optional()
      .describe("Lounge phone: who is using it right now."),
  })
  .describe("Presence and health of a device in the guardian's household.");

export const VoicemailNew = z
  .object({
    t: z.literal("voicemail.new"),
    ...Ref,
    id: Id,
    deviceId: Id,
    from: z.string().min(1).max(24),
  })
  .describe("A voicemail was left for a phone in the guardian's household.");

export const MemberStatus = z
  .object({
    t: z.literal("member.status"),
    ...Ref,
    userId: Id,
    online: z.boolean().describe("Has at least one open companion session."),
    available: z.boolean().describe("Taking app-to-app calls."),
    lounge: z
      .object({ deviceId: Id, label: z.string().min(1).max(24), openToChat: z.boolean() })
      .optional()
      .describe("At a Lounge phone (calls to them ring there)."),
  })
  .describe("Presence of another member of the server; sent on connect and on every change.");

export const LoungeProgress = z
  .object({
    t: z.literal("lounge.progress"),
    ...Ref,
    deviceId: Id,
    step: z.enum(["press_key", "started", "failed", "ended"]),
    reason: z
      .union([z.enum(["expired", "wrong_key", "timeout", "busy", "not_found"]), LoungeReason])
      .optional()
      .describe("Why a claim `failed` or a session `ended`."),
    expiresAt: EpochMs.optional().describe("With `press_key`: when the key proof runs out."),
  })
  .describe("Progress of your takeover of a Lounge phone, and the end of your session there.");

export const ConnectionsChanged = z
  .object({ t: z.literal("connections.changed"), ...Ref })
  .describe(
    "Your connections changed (a knock arrived, someone accepted or disconnected); reload them with `GET /api/connections`.",
  );

export const ServerToApp = z.discriminatedUnion("t", [
  AppReady,
  ConnectionsChanged,
  LoungeProgress,
  MemberStatus,
  DeviceStatus,
  VoicemailNew,
  CallRinging,
  CallStateMsg,
  RtcConfig,
  RtcSdp,
  RtcIce,
  ErrorMsg,
  Pong,
]);
export type ServerToApp = z.infer<typeof ServerToApp>;
