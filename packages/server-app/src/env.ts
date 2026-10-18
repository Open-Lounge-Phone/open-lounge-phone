import type { RoomState } from "@openloungephone/core";
import type { Store } from "@openloungephone/db";
import type {
  CallBody,
  CallResult,
  FedSignal,
  LineCallbackBody,
  LineCallbackMissedBody,
  LineCallbackMissedResult,
  RoomJoinBody,
  RoomJoinResult,
} from "@openloungephone/federation";
import type {
  DeviceToServer,
  IceServer,
  ServerToApp,
  ServerToDevice,
} from "@openloungephone/protocol";

/** Opaque binary storage for voicemail audio (local disk, or R2 on Cloudflare). */
export interface BlobStore {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: ArrayBuffer; contentType: string } | undefined>;
  delete(key: string): Promise<void>;
}

/** Speech-to-text for voicemail (Workers AI Whisper, or an OpenAI-compatible endpoint). */
export interface Transcriber {
  transcribe(audio: ArrayBuffer, contentType: string): Promise<string>;
}

/** Outcome of asking the far end of a federated call to ring. */
export type RingResult = CallResult;

/**
 * Calls whose far end is in another household here (host '') or on another server: placement,
 * the callee side's authorization, and signaling routes (see `FedCalls`).
 */
export interface CallLinks {
  receive(host: string, body: CallBody, peerHousehold?: string): Promise<RingResult>;
  place(host: string, body: CallBody, callerHousehold: string): Promise<RingResult>;
  register(host: string, callId: string, householdId: string): Promise<void>;
  signal(to: { host: string; householdId?: string }, msg: FedSignal): Promise<void>;
  /** Sends a phone in any household here a fresh config (e.g. its owner heard a message). */
  refreshDevice(householdId: string, deviceId: string): Promise<void>;
  /** Sends a message to every open companion session of an account, in all its households. */
  notifyAccount(
    accountId: string,
    msg: import("@openloungephone/protocol").ServerToApp,
  ): Promise<void>;
  /** Rings a person in another household on this server, for a call owned here. */
  ringLocal(householdId: string, req: import("./fedCalls.ts").RemoteRing): Promise<RingResult>;
  /** Someone at `host` asks into one of our phone rooms (`/fed/v1/rooms/join`). */
  receiveRoomJoin(
    host: string,
    body: RoomJoinBody,
    peerHousehold?: string,
  ): Promise<RoomJoinResult>;
  /** Asks a phone room's server (or household, host '') to let one of our people in. */
  roomJoin(host: string, body: RoomJoinBody, callerHousehold: string): Promise<RoomJoinResult>;
  /** A public line here calls someone back (at `host`, '' = this server): ring them now. */
  callbackDue(host: string, body: LineCallbackBody): Promise<void>;
  /** Someone at `host` asks to be rung for a line's call back (`/fed/v1/lines/callback`). */
  receiveCallback(host: string, body: LineCallbackBody): Promise<void>;
  /** Our person didn't take a line's call back: tell the line's server (`host`, '' = here). */
  callbackMissed(host: string, body: LineCallbackMissedBody): Promise<LineCallbackMissedResult>;
  /** Someone at `host` didn't take our line's call back. */
  receiveCallbackMissed(
    host: string,
    body: LineCallbackMissedBody,
  ): Promise<LineCallbackMissedResult>;
}

/** This server's own federation key(s), as stored. */
export interface StoredFederationKeys {
  /** The current private key (JWK JSON, as `generateServerKey` makes it). Never logged. */
  privateKey: string;
  /** A rotation in (or past) its overlap window: the key it replaced and the hand-over. */
  rotation?: import("@openloungephone/federation").KeyRotation & {
    /** The 0.1 statement (`rotation_sig`) for peers running 0.1. */
    legacy_sig: string;
  };
}

/** Storage for this server's own key, so an operator can rotate it without a redeploy. */
export interface FederationKeyStore {
  load(): Promise<StoredFederationKeys | undefined>;
  /** Saves `next` only if the current public key is still `expectPublicKey`. */
  save(next: StoredFederationKeys, expectPublicKey: string): Promise<boolean>;
}

/** Everything the server needs from its host platform. Node and Workers each provide one. */
export interface ServerEnv {
  store: Store;
  blobs: BlobStore;
  /** Absent when no speech-to-text is configured; transcripts are then "unavailable". */
  transcriber?: Transcriber;
  /** Keeps background work alive after the response (Workers `waitUntil`). */
  defer(work: Promise<unknown>): void;
  /** Canonical public URL (e.g. behind a TLS proxy); passkeys bind to its host. */
  publicUrl?: string;
  /**
   * Open sign-up (`OPEN_SIGNUP=1`): anyone may create an account with a passkey, which also
   * creates their own household. Off by default; then people join only through invites.
   */
  openSignup?: boolean;
  /**
   * This server's federation identity: an Ed25519 private key as JWK JSON (Cloudflare secret
   * `FED_PRIVATE_KEY`, or the self-host key file). Without it the server doesn't federate;
   * connections between its own accounts still work.
   */
  federationKey?: string;
  /**
   * Where the server's own key lives once it can rotate (self-host: files in DATA_DIR). Without
   * it, `federationKey` is the root key and a rotated key is kept sealed in the database
   * (`fed_own_key`; the Cloudflare setup). See `ownKeys` in federation.ts.
   */
  federationKeys?: FederationKeyStore;
  /** Outbound HTTP for federation (tests route between in-memory servers). Default: `fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  /** Overrides for rate limits (see `DEFAULT_LIMITS`). */
  limits?: Partial<import("./limits.ts").Limits>;
  /** The fair-use allowance; undefined = unlimited (see `fairUseFromVars`). */
  fairUse?: import("./limits.ts").FairUse;
  /** Cloudflare Turnstile on sign-up; skipped when unset. */
  turnstile?: { siteKey: string; secret: string };
  /** Account ids (`acc_…`) of the server's operators (the admin view); never handles. */
  operators?: string[];
  /** Public-hub details: funding transparency, Sponsor link. */
  hub?: import("./limits.ts").HubInfo;
  /** Trust X-Forwarded-For for the client's IP (behind your own reverse proxy). */
  trustProxy?: boolean;
  /**
   * Refuse calls another server records (`REFUSE_RECORDED_CALLS=1`): its calls to our people
   * that say `recording` are denied, and a call that turns out to be recorded is ended for our
   * people (they're told why). Our own spaces' recording is unaffected.
   */
  refuseRecordedCalls?: boolean;
  /**
   * Add-ons (`ADDONS=on`, docs/add-ons.md): people may link services to their accounts. Off by
   * default: then nobody can link one, linked ones can't connect or be called, and the server
   * doesn't advertise the `addons` feature.
   */
  addons?: boolean;
  now(): number;
  /**
   * ICE servers handed to both peers of a call (STUN, and TURN with fresh credentials). `ttlSeconds`:
   * how long TURN credentials last (the host's default when unset).
   */
  iceServers(opts?: { ttlSeconds?: number }): Promise<IceServer[]>;
  /**
   * Hosts whose TURN service can revoke credentials (Cloudflare) provide this: the call they were
   * made for ended, so these usernames stop working now. Without it they expire on their own.
   */
  revokeIce?(usernames: string[]): Promise<void>;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
  /**
   * Hosts that can sleep (Durable Objects) provide this: the hub asks to be woken at `at` (or
   * cancels with null) and the host calls `HouseholdHub.wake()` then. Without it the hub uses
   * `setTimer`.
   */
  wakeAt?(at: number | null): void;
  /** Hosts that can be evicted persist live call rooms so they survive a restart. */
  saveRooms?(householdId: string, rooms: RoomSnapshot[]): void;
  /** Likewise for live rooms (party lines, phone rooms, 3-way calls) and room legs. */
  saveConferences?(householdId: string, snap: ConferenceSnapshot): void;
  /**
   * A media relay for rooms: the Cloudflare Realtime SFU (`SFU_APP_ID`/`SFU_APP_SECRET`) or a
   * self-hosted LiveKit (`LIVEKIT_*`). Without one, rooms are a peer-to-peer mesh of ≤ 4 people.
   * 1:1 calls never use it.
   */
  relay?: import("./sfu.ts").RelayConfig;
  /**
   * A TURN relay is set up for calls (`TURN_URLS` + `TURN_SECRET`, or Cloudflare's
   * `TURN_KEY_ID` + `TURN_KEY_API_TOKEN`). Only shown to operators; `iceServers` does the work.
   */
  turn?: boolean;
  /** Calls with other households and servers; without it such calls are unreachable. */
  calls?: CallLinks;
  /**
   * A member's presence changed (for sharing with connections that opted in). Resolves to a time
   * when the change was rate-limited and waits to be sent: the hub then wakes at that time and
   * calls `flushPresence`.
   */
  onPresence?(
    householdId: string,
    userId: string,
    online: boolean,
    available: boolean,
  ): Promise<number | undefined> | undefined;
  /** Sends the presence states that waited out their rate limit (see `onPresence`). */
  flushPresence?(householdId: string): Promise<void>;
}

/** Someone from another server at one of our Lounge phones; their home server vouched for them. */
export interface LoungeGuest {
  host: string;
  handle: string;
  /** Their stable account id on their server. */
  id: string;
  name: string;
  /** Their speed-dial here (from their server), dialed through their server. */
  directory: { address: string; name: string }[];
}

/** Live state of a Lounge phone (kept with its socket so it survives the host sleeping). */
export interface LoungeInfo {
  /** Current single-use takeover nonce (in the phone's QR code). */
  nonce: string;
  nonceExpiresAt: number;
  /** Someone scanned the code and must now press the flashing key. */
  challenge?: {
    userId: string;
    name: string;
    index: number;
    expiresAt: number;
    app: string;
    guest?: LoungeGuest;
  };
  /** Who is using the phone. Ephemeral: nothing of it stays on the phone afterwards. */
  session?: {
    id: string;
    userId: string;
    name: string;
    since: number;
    openToChat: boolean;
    guest?: LoungeGuest;
  };
}

/** Everything needed to rebuild an authenticated connection's peer after the host slept. */
export interface PeerInfo {
  /** Unique per connection; rooms refer to peers by it. */
  session: string;
  householdId: string;
  /**
   * `remote` = the far end of a call with another household or server (no socket here);
   * `addon` = an add-on linked to someone's account (docs/add-ons.md).
   */
  kind: "device" | "user" | "remote" | "addon";
  id: string;
  label: string;
  guardian: boolean;
  /** A companion's sign-in session (its public id): signing that session out closes the socket. */
  auth?: string;
  hook?: "up" | "down";
  /** A device that is a person's own phone: their user id. */
  owner?: string;
  /**
   * The phone of someone who left the space: their name ('' if not known). Nobody can call it;
   * it calls out under the strictest rules (kids' rules, without being a kids' phone).
   */
  left?: string;
  /**
   * A kids' phone waiting for a guardian to allow its new firmware (Ask me first): nobody can
   * call it and it calls only its guardians.
   */
  held?: true;
  /** Present for Lounge phones. */
  lounge?: LoungeInfo;
  status?: Extract<DeviceToServer, { t: "status" }>;
  lastQuiet?: boolean;
  /** Remote peers: the other server ('' = another household here). */
  host?: string;
  /** Remote peers in another household here: that household. */
  peerHousehold?: string;
  /** Remote peers: the call's id on their server, when it differs from the room's. */
  leg?: string;
  /** Remote peers: who they are, for the call log (`handle@host` or `device:<id>@host`). */
  address?: string;
  /**
   * Remote peers: another server's Lounge phone where one of our accounts is a guest, calling
   * through us (`relayDial`). A voicemail offer is sent to it (and to `transferred` peers).
   */
  loungeRelay?: boolean;
  /**
   * Remote peers: the far end of a call a team/org space transferred. On the space's side (the
   * person transferred) they get its voicemail offer if the target doesn't answer, like a
   * caller from here would; on their side (the space) that offer is relayed to our caller.
   */
  transferred?: boolean;
  /**
   * The far end is a kids' phone (it called through a guardian's connection, or we called one):
   * a call with it is never recorded.
   */
  kidsPhone?: boolean;
  /**
   * An add-on: its name and address (`handle+name@host`). For our own add-ons (`kind` `addon`)
   * also its owner's account and membership here; for a remote peer, the far end is an add-on.
   */
  addon?: {
    name: string;
    address: string;
    accountId?: string;
    ownerUserId?: string;
    /** An add-on elsewhere calling within one of its shares: the share's label. */
    share?: string;
    /** Our own add-ons: what the server lets it do, from what it said (`addon.about`). */
    rules?: AddonRules;
  };
  /** A phone whose client can record calls (the browser phone; not yet firmware). */
  canRecord?: boolean;
  /** What a phone said it handles beyond the base protocol (`hello.features`). */
  features?: string[];
  /**
   * Remote peers: someone calling one of our public lines. They get the line's queue updates
   * (`call.state ringing` + `queue`) and its voicemail offer, through their server.
   */
  line?: boolean;
}

/** What an add-on may do here, from `addon.about` (or server 0.7.0's rules if it never said). */
export interface AddonRules {
  /** People may call it. */
  answers: boolean;
  /** It may call people (its owner, holders within a share). */
  calls: boolean;
  /** It may offer shares. */
  shares: boolean;
  /** Keys pressed in its calls reach it. */
  keys: boolean;
  /** Calls it takes at once (already capped by the server's limit). */
  lines: number;
}

/** Which of a member's companion sockets to close (see `Coordinator.closeApps`). */
export interface AppCloseFilter {
  /** Only sockets of these sign-in sessions (public ids). */
  only?: string[];
  /** All but this session's sockets. */
  except?: string;
  /**
   * Close code `removed` (they left the space, or their role there changed: the app reloads and
   * reconnects if it still can); otherwise they were signed out.
   */
  removed?: boolean;
  /** The close reason sent with `removed`. */
  reason?: string;
}

/** Per-connection state a sleeping host keeps alongside the socket (≤16 KiB serialized). */
export type ConnMemo = { kind: "peer"; peer: PeerInfo } | { kind: "pairing"; code: string };

export interface RoomSnapshot {
  id: string;
  state: RoomState;
  /** Sessions of the caller and, once known, the callee. */
  caller: string;
  callee?: string;
  /** Far ends in another household or on another server (they have no socket to restore). */
  remotes?: PeerInfo[];
  /** Places still ringing for the callee elsewhere (their other spaces, a remote Lounge phone). */
  branches?: PeerInfo[];
  /** Fair-use metering: who pays, and when media started. */
  payer?: string;
  activeAt?: number;
  /** For the call log. */
  startedAt?: number;
  answered?: boolean;
  /** Voicemail if the call goes unanswered: for whom, and the caller as its sender. */
  vm?: { target: import("./vmTickets.ts").VmTarget; from: import("./vmTickets.ts").VmCaller };
  /** A house-line key ringing several members at once (user ids). */
  group?: string[];
  /** On hold: the party key of whoever put it on hold. */
  heldBy?: string;
  /** A call to a ring group: its steps and where it is. */
  hunt?: HuntState;
  /** Recording announced for this call (by this space, or by the far side's). */
  recording?: { by: string; ours: boolean };
  /** Never recorded (e.g. we called a kids' phone elsewhere). */
  noRecording?: boolean;
  /** TURN usernames handed out for the call (revoked when it ends, where the host can). */
  turnUsers?: string[];
  /** A call to one of our public lines: its place in the line's queue. */
  line?: LineCallState;
  /** A call to a public line elsewhere: its queue updates and voicemail offer pass through. */
  farLine?: boolean;
  /** Rings a person here for a call another household here owns: its missed call is theirs. */
  branchLeg?: boolean;
  /** A call with one of our add-ons within one of its shares (`grantId`: the holder's grant). */
  addonShare?: { id: string; label: string; grantId?: string };
}

/** A call to a public line, waiting in its queue or ringing its members (see the hub). */
export interface LineCallState {
  /** The line's ring group (the queue it waits in). */
  groupId: string;
  /** What the caller and the members see of the line. */
  info: import("@openloungephone/protocol").LineInfo;
  /** Who's calling: their verified address and name (for members and "Recent callers"). */
  address: string;
  name: string;
  /** When they joined the line: their place in it. */
  since: number;
  /** Waiting in line now; false while the line rings its members (or after it's answered). */
  waiting: boolean;
  /** When the line's longest wait runs out. */
  waitUntil: number;
  /** The longest wait ran out while members were ringing: it applies when that ends. */
  expired?: boolean;
  /** Left the line for good (voicemail, overflow): never queues again. */
  done?: boolean;
  /** The queue update last sent to the caller (only changes are sent). */
  sent?: string;
  /**
   * Who to call back if they ask (feature `line-callback`): a person here or on a server that
   * can take the call back. Absent = "call me back" isn't offered (e.g. an idle Lounge phone).
   */
  callback?: { host: string; accountId: string; handle: string };
}

/** A call ringing a ring group, step by step (see `huntSteps` in `packages/core`). */
export interface HuntState {
  groupId: string;
  name: string;
  /** Members (user ids) rung together at each step. */
  steps: string[][];
  step: number;
  stepMs: number;
  /** What the members' phones and apps show while ringing. */
  label: string;
}

/** One of our people in a room on another server or in another household (their "leg"). */
export interface RoomLegSnapshot {
  leg: string;
  roomId?: string;
  /** The local peer's session. */
  session: string;
  to: { host: string; householdId?: string };
  joinedAt: number;
  payer?: string;
}

export interface ConferenceSnapshot {
  rooms: import("./liveRooms.ts").LiveRoomSnapshot[];
  legs: RoomLegSnapshot[];
}

/** One WebSocket, as seen by the server. */
export interface Conn {
  send(msg: ServerToDevice | ServerToApp): void;
  close(code: number, reason: string): void;
  /** Hosts that can sleep store this with the socket; see `Gateway.resume`. */
  remember?(memo: ConnMemo): void;
}

/** WebSocket close codes used by the server (4000-4999 is the application range). */
export const CloseCode = {
  replaced: 4000,
  badHandshake: 4400,
  unauthorized: 4401,
  /** The person left or was removed from this space; their session (and other spaces) remain. */
  removed: 4403,
  timeout: 4408,
  /** Sent too much (an add-on over its message limit). */
  tooMuch: 4429,
} as const;

export const HELLO_TIMEOUT_MS = 10_000;
/** Default ring time before voicemail (a person or phone can set their own, 10–60 s). */
export const RING_TIMEOUT_MS = 25_000;
export const CONNECT_TIMEOUT_MS = 20_000;
/** A Lounge phone's QR nonce is valid this long (and single use); the phone asks for more. */
export const LOUNGE_NONCE_TTL_MS = 120_000;
/** A Lounge session survives its phone reconnecting within this long. */
export const LOUNGE_RECONNECT_GRACE_MS = 60_000;
/** Time to press the flashing key after scanning a Lounge phone's code. */
export const LOUNGE_PROOF_MS = 30_000;
