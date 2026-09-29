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
    peer: Id.optional().describe(
      "Rooms without a relay (peer-to-peer mesh): the other participant this is for (sent) or from (received); `callId` is then the room id.",
    ),
  })
  .describe(
    "SDP offer/answer, relayed to the other party of a call (or a mesh room's participant).",
  );

export const RtcIce = z
  .object({
    t: z.literal("rtc.ice"),
    ...Ref,
    callId: Id,
    candidate: z.string().nullable().describe("null signals end-of-candidates."),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
    peer: Id.optional().describe("Mesh rooms: the other participant (see `rtc.sdp`)."),
  })
  .describe("Trickled ICE candidate.");

export const Ping = z.object({ t: z.literal("ping"), ...Ref }).describe("Keep-alive.");

// ---------------------------------------------------------------------------
// Hold, 3-way (merge into a room), transfer, and rooms. Shared by phones and apps.
// ---------------------------------------------------------------------------

export const CallHold = z
  .object({ t: z.literal("call.hold"), ...Ref, callId: Id, hold: z.boolean() })
  .describe(
    "Put an answered call on hold (`hold: true`) or take it back. The other side hears a soft tone (played by its own phone or app) and your audio stops; you may then place one more call (consult).",
  );

export const CallMerge = z
  .object({
    t: z.literal("call.merge"),
    ...Ref,
    callId: Id.describe("The call on hold."),
    with: Id.describe("The call you're in now (the consult call)."),
  })
  .describe(
    "3-way: join both calls into one room. Both calls end with `merged` and `room.state` follows; keep the old audio playing until the room's audio is connected, so nobody hears a gap.",
  );

export const TransferTarget = z
  .union([
    z.object({ button: z.number().int().min(0).max(15) }).describe("Phones: a speed-dial key."),
    z.object({ userId: Id }),
    z.object({ deviceId: Id }),
    z.object({ connectionId: Id }),
    z
      .object({ extension: z.string().regex(/^[0-9]{2,6}$/) })
      .describe("Team/org spaces: an extension of the space (a member, phone or ring group)."),
    z.object({ groupId: Id }).describe("Team/org spaces: a ring group of the space."),
  ])
  .describe(
    "Who to transfer to. Someone in another household or on another server can be transferred only inside a team/org space, to its members, phones, ring groups and extensions.",
  );
export type TransferTarget = z.infer<typeof TransferTarget>;

export const CallTransfer = z
  .object({
    t: z.literal("call.transfer"),
    ...Ref,
    callId: Id.describe("The call to hand over (the other person in it is transferred)."),
    to: TransferTarget.optional().describe(
      "Blind transfer: ring this target for them; you leave at once. Allowed only if they could call the target themselves.",
    ),
    toCall: Id.optional().describe(
      "Attended transfer: your other call (consult); the two other people are connected and you leave both calls.",
    ),
  })
  .refine((m) => (m.to === undefined) !== (m.toCall === undefined), {
    message: "give exactly one of to, toCall",
  })
  .describe("Transfer a call: blind (`to`) or attended (`toCall`).");

export const CallExtension = z
  .object({
    t: z.literal("call.extension"),
    ...Ref,
    number: z.string().regex(/^[0-9]{2,6}$/),
  })
  .describe(
    "Team/org spaces: dial an extension of your space (a member, a phone, a room or a ring group). Phones: MENU → Dial extension, the digits, then MENU. Refused (`denied`) in homes and for unknown numbers; a ring group that's closed follows its after-hours action.",
  );

export const WorkplacePrompt = z
  .enum(["ext.enter", "ext.unknown", "ext.closed"])
  .describe(
    'Audio prompt ids for team/org phones (pre-recorded on hardware; the browser phone speaks them). `ext.enter` "Enter the extension, then press MENU.", `ext.unknown` "There\'s no such extension.", `ext.closed` "We\'re closed right now. Please leave a message."',
  );
export type WorkplacePrompt = z.infer<typeof WorkplacePrompt>;

export const RoomJoin = z
  .object({
    t: z.literal("room.join"),
    ...Ref,
    roomId: Id.optional().describe("A room of this space (party line or phone room)."),
    address: z
      .string()
      .min(3)
      .max(300)
      .optional()
      .describe("A phone room's address `name@host`, on this server or another one."),
  })
  .refine((m) => (m.roomId === undefined) !== (m.address === undefined), {
    message: "give exactly one of roomId, address",
  })
  .describe(
    "Companion app: join a room. Answered with `room.state` (you're in) or `room.ended` (refused). Phones join with a speed-dial key a guardian set up.",
  );

export const RoomLeave = z
  .object({ t: z.literal("room.leave"), ...Ref, roomId: Id })
  .describe("Leave a room (a phone's hook going down does the same).");

export const RoomMute = z
  .object({
    t: z.literal("room.mute"),
    ...Ref,
    roomId: Id,
    muted: z.boolean(),
    participant: Id.optional().describe(
      "The host mutes someone else (they may unmute themselves). Default: yourself.",
    ),
  })
  .describe("Mute or unmute. A muted participant's audio isn't forwarded by the relay.");

export const RoomRemove = z
  .object({ t: z.literal("room.remove"), ...Ref, roomId: Id, participant: Id })
  .describe("Host only: remove a participant (they get `room.ended` `removed`).");

export const RoomLock = z
  .object({ t: z.literal("room.lock"), ...Ref, roomId: Id, locked: z.boolean() })
  .describe("Host only: a locked room lets nobody new in.");

export const RoomTalk = z
  .object({ t: z.literal("room.talk"), ...Ref, roomId: Id, speaking: z.boolean() })
  .describe(
    "Voice activity from your own microphone (send on changes only). Picks the active speakers a relay forwards in big rooms, and counts as activity for the idle rule.",
  );

export const RoomHere = z
  .object({ t: z.literal("room.here"), ...Ref, roomId: Id })
  .describe("Any interaction with the room (e.g. an answer to `room.idle`): you're still here.");

export const RoomMediaMsg = z
  .object({
    t: z.literal("room.media"),
    ...Ref,
    roomId: Id,
    type: z
      .enum(["offer", "answer", "close"])
      .describe(
        "`offer`/`answer`: SDP. `close` (server → client): stop the transceivers with these `mids`, then send a new `offer`.",
      ),
    sdp: z.string().min(1).optional(),
    mids: z.array(z.string().min(1).max(8)).max(32).optional(),
  })
  .refine((m) => (m.type === "close" ? !!m.mids?.length : !!m.sdp), {
    message: "offer/answer need sdp; close needs mids",
  })
  .describe(
    "Rooms with a relay (`media: sfu`): the one peer connection to the relay. The client offers its microphone once and the server answers. Then the server adds the other participants' audio (it offers, the client answers) and, when the active speakers change, asks the client to `close` a slot (the client stops it and offers; the server answers). The server decides whose audio you get.",
  );

export const RecordingNotice = z
  .object({
    by: z.string().min(1).max(64).describe("The space that records (its name)."),
    ticket: z
      .string()
      .min(16)
      .max(128)
      .optional()
      .describe(
        "Only to the one client that makes the recording (the recording side's own app or phone): record what you send and what you hear until the call ends (or you leave the room), at most `maxMs`, then `POST /api/rec/upload?ticket=&durationMs=` with a raw `audio/*` body. Single use.",
      ),
    maxMs: z.number().int().positive().optional().describe("With `ticket`: the longest recording."),
  })
  .describe(
    'This call or room is recorded. Every party gets it — on other servers too, from their own server — before the recorder gets its ticket. Play prompt `call.recorded` ("This call is recorded."), show a mark in the app, and on a phone light the recording light, until the call ends. Absent = not recorded.',
  );
export type RecordingNotice = z.infer<typeof RecordingNotice>;

export const RoomRole = z.enum(["host", "member"]);

export const RoomParticipant = z.object({
  id: Id,
  name: z.string().min(1).max(24),
  muted: z.boolean(),
  speaking: z.boolean().optional(),
  host: z.boolean().optional(),
  remote: z.string().max(260).optional().describe("From another server: its host."),
});
export type RoomParticipant = z.infer<typeof RoomParticipant>;

export const RoomEndReason = z
  .enum([
    "left",
    "removed",
    "idle",
    "closed",
    "denied",
    "locked",
    "full",
    "unreachable",
    "busy",
    "error",
  ])
  .describe(
    "`left` = you left; `removed` = the host removed you; `idle` = 10 minutes of silence and no interaction after a warning; `closed` = the room went away; `denied` = not allowed (default deny) or over the fair-use allowance; `locked` = the host locked it; `full` = no room (a relay-less room holds 4); `unreachable` = its server can't be reached; `busy` = you're in a call.",
  );
export type RoomEndReason = z.infer<typeof RoomEndReason>;

export const RoomState = z
  .object({
    t: z.literal("room.state"),
    ...Ref,
    roomId: Id,
    name: z.string().min(1).max(40),
    kind: z
      .enum(["party", "phone", "call"])
      .describe(
        "`party` = a space's always-open party line; `phone` = a named room with an address; `call` = a 3-way call made by merging.",
      ),
    address: z.string().max(300).optional().describe("`phone` rooms: `name@host`."),
    you: Id.describe("Your participant id."),
    locked: z.boolean(),
    media: z
      .enum(["sfu", "mesh", "livekit"])
      .describe(
        "`mesh` = peer to peer (≤ 4 people, `rtc.*` with `peer`, end-to-end encrypted); `sfu` = through the room owner's relay (`room.media`); `livekit` = through the owner's LiveKit server (`livekit`). Relayed rooms are encrypted in transit, not end to end (the relay could hear them); end-to-end room encryption (SFrame) is planned.",
      ),
    e2ee: z.boolean().describe("Whether only the participants can hear the audio."),
    participants: z.array(RoomParticipant).max(32),
    forward: z
      .array(Id)
      .max(32)
      .optional()
      .describe(
        "Relayed rooms: whose audio the relay sends you now (top 3 speakers in rooms of more than 4).",
      ),
    livekit: z
      .object({ url: z.string().max(300), token: z.string().max(2048) })
      .optional()
      .describe("`media: livekit`: where to connect and your join token (for you only)."),
    note: z.string().max(200).optional(),
    recording: RecordingNotice.optional().describe(
      "The room is recorded by its space (see `RecordingNotice`); `ticket` only to the participant who records.",
    ),
  })
  .describe("You're in a room: who's there and how its audio travels. Sent on every change.");

export const RoomIdle = z
  .object({ t: z.literal("room.idle"), ...Ref, roomId: Id, dropAt: EpochMs })
  .describe(
    "10 minutes of silence and no interaction: you'll be dropped at `dropAt` unless you speak or interact (`room.here`). Phones play prompt `room.idle`.",
  );

export const RoomEnded = z
  .object({
    t: z.literal("room.ended"),
    ...Ref,
    roomId: Id.optional().describe(
      "Absent when a join by address was refused before a room was known.",
    ),
    reason: RoomEndReason,
    note: z.string().max(200).optional(),
  })
  .describe("You're out of the room (or weren't let in).");

export const CallPrompt = z
  .enum([
    "hold.tone",
    "call.on_hold",
    "call.add",
    "call.merged",
    "call.transfer",
    "call.transferred",
    "room.joined",
    "room.left",
    "room.idle",
    "room.removed",
    "room.locked",
    "room.full",
    "room.muted",
    "room.unmuted",
    "call.recorded",
  ])
  .describe(
    `Audio prompt ids for hold, 3-way calls, transfer and rooms (pre-recorded on hardware; the browser phone speaks them). \`hold.tone\` = the soft on-hold tone (played locally, repeating), \`call.on_hold\` "You're on hold.", \`call.add\` "Choose who to add, then press MENU to merge.", \`call.merged\` "You're all together now.", \`call.transfer\` "Choose who to transfer to.", \`call.transferred\` "Call transferred.", \`room.joined\` "You're in the room.", \`room.left\` "You left the room.", \`room.idle\` "Still there? Press any key to stay.", \`room.removed\` "The host removed you from the room.", \`room.locked\` "That room is locked.", \`room.full\` "That room is full.", \`room.muted\` "Muted.", \`room.unmuted\` "Unmuted.", \`call.recorded\` "This call is recorded." (when \`recording\` first appears on a call or room).`,
  );
export type CallPrompt = z.infer<typeof CallPrompt>;

// ---------------------------------------------------------------------------
// Voicemail: greetings and the offer that follows an unanswered call.
// ---------------------------------------------------------------------------

export const GreetingKind = z
  .enum(["default", "name", "custom"])
  .describe(
    "`default` = the spoken \"<Name> can't take your call. Leave a message after the tone.\"; `name` = the same sentence with the person's own recording of their name (≤ 3 s); `custom` = their own whole greeting (≤ 30 s).",
  );
export type GreetingKind = z.infer<typeof GreetingKind>;

export const VoicemailPrompt = z
  .enum([
    "name",
    "greeting",
    "vm.person",
    "vm.cant_take",
    "vm.leave_message",
    "vm.tone",
    "vm.sent",
    "vm.not_sent",
    "greet.say_name",
    "greet.say_greeting",
    "greet.saved",
    "greet.not_saved",
    "greet.default",
    "greet.not_allowed",
  ])
  .describe(
    'Audio prompt ids, pre-recorded on hardware (the browser phone speaks them). Slots: `name` = the recorded name when the greeting is `name`, else `name` spoken (hardware without speech plays `vm.person`, "The person you called"); `greeting` = the recorded custom greeting. Fixed: `vm.cant_take` "can\'t take your call.", `vm.leave_message` "Leave a message after the tone.", `vm.tone` the beep, `vm.sent` "Message sent.", `vm.not_sent` "Your message wasn\'t sent.", `greet.say_name` "Say your name after the tone, then press BACK.", `greet.say_greeting` "Record your greeting after the tone, then press BACK.", `greet.saved` "Greeting saved.", `greet.not_saved` "The greeting wasn\'t saved.", `greet.default` "Callers will hear the standard greeting.", `greet.not_allowed` "Ask a grown-up to change the greeting."',
  );
export type VoicemailPrompt = z.infer<typeof VoicemailPrompt>;

export const VoicemailOffer = z
  .object({
    ticket: z
      .string()
      .min(16)
      .max(128)
      .describe(
        "Single use, expires in 10 minutes. `GET /api/vm/greeting?ticket=` returns the greeting audio (`olp-greeting: name|custom`) or 204 for the default; `POST /api/vm/message?ticket=&durationMs=` with a raw `audio/*` body leaves the message.",
      ),
    name: z.string().min(1).max(24).describe("Who was called, for the spoken default greeting."),
    maxMs: z.number().int().positive().describe("Longest message accepted (2 minutes)."),
    prompts: z
      .array(VoicemailPrompt)
      .max(8)
      .describe(
        'What to play before recording, in order, for the `default` and `name` greetings: `["name","vm.cant_take","vm.leave_message","vm.tone"]`. For a `custom` greeting play `greeting`, then `vm.tone`.',
      ),
  })
  .describe(
    "The call wasn't answered (no answer, declined, busy, quiet hours, unavailable, offline): the caller may leave a message. Play the greeting, the tone, record until hang-up, then upload.",
  );
export type VoicemailOffer = z.infer<typeof VoicemailOffer>;

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
        "Status display fitted: `eink` = the e-ink strip (standard on the board); `seg14` / `oled` / `none` remain for other builds and the browser phone (`none` = keys, LEDs and voice only, with printed key labels).",
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

export const PhoneMode = z
  .enum(["kids", "personal", "lounge"])
  .describe(
    "How a phone is used, chosen when it's claimed: `kids` = a home's phone for a child (its own allow-list, quiet hours); `personal` = one person's own desk or bedside phone, always signed in as them; `lounge` = a space's shared phone that people sign in to (idle until someone does).",
  );
export type PhoneMode = z.infer<typeof PhoneMode>;

export const PairBegin = z
  .object({
    t: z.literal("pair.begin"),
    ...Ref,
    alg: KeyAlg.optional().describe("Defaults to `ed25519`."),
    kind: PhoneMode.optional().describe(
      "What the phone was set up as (first-run choice: a `PhoneMode`); whoever claims it can choose another mode. Defaults to `kids`.",
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

export const GreetingBegin = z
  .object({ t: z.literal("greeting.begin"), ...Ref, kind: z.enum(["name", "custom"]) })
  .describe(
    "MENU → Voicemail → Record: the phone wants to record its greeting (a kids' phone: its own; a person's own phone: theirs). Answered with `greeting.ticket`, or `greeting.done` `not_allowed`.",
  );

export const GreetingReset = z
  .object({ t: z.literal("greeting.reset"), ...Ref })
  .describe("MENU → Voicemail → Default: back to the spoken default greeting.");

export const DeviceToServer = z.discriminatedUnion("t", [
  DeviceHello,
  CallExtension,
  PairBegin,
  AuthProof,
  Hook,
  Button,
  Status,
  LoungePress,
  LoungeRefresh,
  LoungeLeave,
  LoungeChat,
  GreetingBegin,
  GreetingReset,
  CallAnswer,
  CallHangup,
  CallHold,
  CallMerge,
  CallTransfer,
  RoomLeave,
  RoomMute,
  RoomLock,
  RoomRemove,
  RoomTalk,
  RoomHere,
  RoomMediaMsg,
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
    greeting: z
      .object({
        kind: GreetingKind,
        canRecord: z
          .boolean()
          .describe(
            "Whether MENU → Voicemail may change it (a kids' phone: the guardians' \"let the child record the greeting\").",
          ),
      })
      .optional()
      .describe("The phone's voicemail greeting (absent on Lounge phones)."),
    owner: z
      .object({
        mode: PhoneMode,
        space: z.string().min(1).max(64).describe("The space it belongs to."),
        person: z.string().min(1).max(24).optional().describe("`personal`: whose phone it is."),
      })
      .optional()
      .describe(
        'Who the phone belongs to and how it is used, for the status strip\'s trust line ("Kids · Smith home", "Jesse\'s phone", "Lounge · Office").',
      ),
    houseLine: z
      .boolean()
      .optional()
      .describe(
        "Lounge phone with nobody signed in: `buttons` are the space's house-line keys, and pressing one calls as the space (off unless the space turns it on).",
      ),
    here: z
      .array(
        z.object({
          name: z.string().min(1).max(24),
          where: z.string().min(1).max(24).describe("The Lounge phone they're at."),
        }),
      )
      .max(8)
      .optional()
      .describe(
        'Lounge phone with nobody signed in, when the space turns on "who\'s here": people signed in at its other Lounge phones who are open to chat.',
      ),
    extensions: z
      .boolean()
      .optional()
      .describe(
        "The phone's space is a team or org with extensions: MENU offers Dial extension (`call.extension`).",
      ),
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
    note: z
      .string()
      .max(200)
      .optional()
      .describe(
        "With `ended`: the server's explanation in words, when it has one (e.g. a fair-use allowance reached).",
      ),
    voicemail: VoicemailOffer.optional().describe(
      "With `ended`, to the caller only: the call went unanswered and a message may be left.",
    ),
    hold: z
      .enum(["you", "them"])
      .optional()
      .describe(
        "With `active`: `you` = you put this call on hold; `them` = the other side did (play the soft `hold.tone`). Absent = not on hold.",
      ),
    merged: z
      .object({ roomId: Id })
      .optional()
      .describe(
        "With `ended` (reason `hangup`): the call became part of a room (3-way). Keep its audio until the room's is connected; `room.state` follows.",
      ),
    transfer: z
      .object({
        callId: Id,
        ringing: z.boolean().describe("true = blind transfer: the new call is ringing its target."),
        offerer: z
          .boolean()
          .describe("Whether you send the SDP offer in the new call (you're its caller)."),
      })
      .optional()
      .describe(
        "With `ended` (reason `hangup`): you were transferred; your call continues as `callId` (you're its caller when `ringing`).",
      ),
    recording: RecordingNotice.optional().describe(
      "With `active`: the call is recorded (sent once, when it starts; it stays on until the call ends). Firmware drives the recording light from it.",
    ),
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
    "`logout` = MENU → Log out on the phone; `left` = Leave in the app; `idle` = the space's session length ran out (idle minutes, or end of day); `replaced` = a new takeover; `removed` = the person was removed; `offline` = the phone disconnected.",
  );

export const LoungeEnded = z
  .object({ t: z.literal("lounge.ended"), ...Ref, reason: LoungeReason })
  .describe(
    "Lounge phone: the session is over. Forget everything about the person (names, speed-dial, call history) and show the takeover code again.",
  );

export const GreetingTicket = z
  .object({
    t: z.literal("greeting.ticket"),
    ...Ref,
    kind: z.enum(["name", "custom"]),
    ticket: z.string().min(16).max(128),
    maxMs: z.number().int().positive(),
  })
  .describe(
    "Go ahead: record up to `maxMs` (name 3 s, greeting 30 s) and `POST /api/vm/greeting?ticket=&durationMs=` with a raw `audio/*` body. Single use, expires in 10 minutes.",
  );

export const GreetingDone = z
  .object({
    t: z.literal("greeting.done"),
    ...Ref,
    result: z.enum(["reset", "not_allowed"]),
    kind: GreetingKind.describe("The greeting callers hear now."),
  })
  .describe(
    "The phone asked to record (`greeting.begin`) and may not, or its greeting was reset (`greeting.reset`). A recorded greeting is confirmed by the upload's HTTP 201.",
  );

export const Wipe = z
  .object({
    t: z.literal("wipe"),
    ...Ref,
    reason: z
      .enum(["removed"])
      .describe("`removed` = its owner removed it in the app (the server has forgotten its key)."),
  })
  .describe(
    'The phone must wipe itself: forget its device id, owner and settings, delete its device key and make a new one, then show "Set me up" again (Wi-Fi is kept so it can be claimed again; a factory reset clears that too). Sent to a removed phone that is connected, or when it next connects and proves it holds the removed key.',
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
  GreetingTicket,
  GreetingDone,
  Wipe,
  CallRinging,
  CallStateMsg,
  RtcConfig,
  RtcSdp,
  RtcIce,
  RoomState,
  RoomMediaMsg,
  RoomIdle,
  RoomEnded,
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

export const CallConnection = z
  .object({ t: z.literal("call.connection"), ...Ref, connectionId: Id })
  .describe(
    "Call someone you're connected with (another household or another server). Their server decides: an active connection, their availability and busy state apply.",
  );

export const CallPhone = z
  .object({ t: z.literal("call.phone"), ...Ref, connectionId: Id, deviceId: Id })
  .describe(
    "Call a household phone that a connection's guardian put you on the allow-list of (`GET /api/connections` lists them as `phones`). Its own allow-list and quiet hours decide.",
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
  CallExtension,
  CallDial,
  CallUser,
  CallConnection,
  CallPhone,
  PresenceSet,
  LoungeClaim,
  LoungeAppLeave,
  CallAnswer,
  CallHangup,
  CallHold,
  CallMerge,
  CallTransfer,
  RoomJoin,
  RoomLeave,
  RoomMute,
  RoomLock,
  RoomRemove,
  RoomTalk,
  RoomHere,
  RoomMediaMsg,
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

export const VoicemailInbox = z
  .object({
    t: z.literal("voicemail.inbox"),
    ...Ref,
    id: Id,
    from: z.string().min(1).max(24),
    box: z
      .string()
      .min(1)
      .max(40)
      .optional()
      .describe("Left in a ring group's shared box you're in (its name)."),
  })
  .describe(
    "A voicemail was left for you (your own inbox, or a shared box of a ring group you're in: `GET /api/voicemails`).",
  );

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
    host: z
      .string()
      .max(260)
      .optional()
      .describe("Set when the Lounge phone is on another server (you're a guest there)."),
  })
  .describe("Progress of your takeover of a Lounge phone, and the end of your session there.");

export const ConnectionsChanged = z
  .object({ t: z.literal("connections.changed"), ...Ref })
  .describe(
    "Your connections changed (a knock arrived, someone accepted or disconnected); reload them with `GET /api/connections`.",
  );

export const RoomsChanged = z
  .object({
    t: z.literal("rooms.changed"),
    ...Ref,
    roomId: Id,
    people: z
      .array(z.string().min(1).max(24))
      .max(32)
      .describe("Who's in the room now (names), for members who aren't in it."),
  })
  .describe("Someone came into or left one of your space's rooms (\"members see who's in\").");

export const ServerToApp = z.discriminatedUnion("t", [
  AppReady,
  ConnectionsChanged,
  LoungeProgress,
  MemberStatus,
  DeviceStatus,
  VoicemailNew,
  VoicemailInbox,
  CallRinging,
  CallStateMsg,
  RtcConfig,
  RtcSdp,
  RtcIce,
  RoomState,
  RoomMediaMsg,
  RoomIdle,
  RoomEnded,
  RoomsChanged,
  ErrorMsg,
  Pong,
]);
export type ServerToApp = z.infer<typeof ServerToApp>;
