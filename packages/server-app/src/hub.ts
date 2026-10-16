import {
  ADDON_FULL_NOTE,
  ADDON_NO_CALLS_NOTE,
  ADDON_NOT_LINKED_NOTE,
  ADDON_OFFLINE_NOTE,
  ADDONS_OFF_NOTE,
  afterHoursAction,
  afterMissedCallback,
  authorizeInbound,
  authorizeOutbound,
  CALLBACK_ANSWER_GRACE_MS,
  CALLBACK_KEEP_MS,
  CALLBACK_RING_MS,
  CALLER_BUSY_NOTE,
  CANT_CALL_NOTE,
  CLOSED_NOTE,
  CONNECTION_LOST_NOTE,
  type Contact,
  checkinStep,
  controlCheck,
  effectiveHours,
  goesToVoicemail,
  huntSteps,
  isOpen,
  isQuietAt,
  keyIndex,
  LEFT_PHONE_CANT_NOTE,
  LEFT_PHONE_NOTE,
  LINE_ENDED_NOTE,
  leftPhoneName,
  localClock,
  localDay,
  loungeDayEnd,
  MAX_RING_SECONDS,
  type Meeting,
  maxWaitOutcome,
  mayConnect,
  mayLeaveVoicemailInstead,
  mayOfferCallback,
  NO_EXTENSION_NOTE,
  newRoom,
  nextNoticeExpiry,
  nextQuietChange,
  nextRoundRobin,
  noQueueOutcome,
  noticeFor,
  noticeLines,
  opensText,
  type PartyCall,
  pickRecorder,
  queueAdmit,
  queueOrder,
  queuePositions,
  RECORDING_MAX_MS,
  RECORDING_MODELS,
  type RoomEvent,
  type RoomHours,
  type RoomHoursStep,
  type RoomState,
  recordingDecision,
  resolveButton,
  roomAccess,
  roomHoursStep,
  roomOpenAt,
  roomStep,
  SIGN_IN_FOR_LINES_NOTE,
  splitKeyPages,
  utcOffsetMinutes,
  validKeyIndex,
} from "@openloungephone/core";
import {
  type Account,
  type Addon,
  type Device,
  deviceMode,
  type HouseLineKey,
  isLineContactId,
  isRemoteContactId,
  isRoomContactId,
  type LineCallback,
  LOCAL_HOST,
  type MissedOwner,
  newId,
  type PublicLine,
  type RingGroup,
  type Notice as StoredNotice,
  type Room as StoredRoom,
  type User,
  type VoicemailOwner,
} from "@openloungephone/db";
import {
  type AddonAddress,
  type AddonTestResult,
  type CallBody,
  type FedSignal,
  formatAddonAddress,
  type LineCallbackMissedResult,
  type Party,
  parseAddonAddress,
  parseAddress,
  type RoomJoinResult,
  type RoomSignalMsg,
} from "@openloungephone/federation";
import {
  type AppToServer,
  type DeviceToServer,
  type EndReason,
  encode,
  KEYS_PER_PAGE,
  MAX_KEY_PAGES,
  MAX_MESSAGE_BYTES,
  type OwnerMode,
  type RoomEndReason,
  type ServerToApp,
  type ServerToDevice,
  type TransferTarget,
  toBase64Url,
  type VoicemailOffer,
} from "@openloungephone/protocol";
import {
  ADDON_MESSAGES,
  addonAccess,
  addonAddress,
  addonCallerLimited,
  addonCallsOutLimited,
  answerShareRequest,
  cleanText,
  noteShareGone,
  rulesOf,
  selfOf,
  tellHolder,
} from "./addons.ts";
import {
  type AppCloseFilter,
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type ConferenceSnapshot,
  type Conn,
  type HuntState,
  type LineCallState,
  LOUNGE_NONCE_TTL_MS,
  LOUNGE_PROOF_MS,
  LOUNGE_RECONNECT_GRACE_MS,
  type LoungeGuest,
  type LoungeInfo,
  type PeerInfo,
  RING_TIMEOUT_MS,
  type RingResult,
  type RoomSnapshot,
  type ServerEnv,
} from "./env.ts";
import { fairUseProblem } from "./fairUse.ts";
import {
  type CallbackMissed,
  type CallbackRing,
  placeGuestDial,
  primaryHousehold,
  REFUSES_RECORDING,
  type RelayDial,
  type RemoteRing,
  type RemoteRoomJoin,
  sendGuestProgress,
} from "./fedCalls.ts";
import { ownHost } from "./federation.ts";
import { limitsOf } from "./limits.ts";
import { admitLineCall, lineInfo, logLineCaller } from "./lines.ts";
import { type LiveRoom, LiveRooms, type RoomInbound } from "./liveRooms.ts";
import { peerSupports, UNAVAILABLE } from "./peers.ts";
import { SWEEP_EVERY_MS, sweepSpace } from "./timeline.ts";
import { serverInfo } from "./version.ts";
import {
  issueGreetingTicket,
  issueVoicemailOffer,
  type VmCaller,
  type VmTarget,
} from "./vmTickets.ts";
import { greetingOf, resetGreeting } from "./voicemail.ts";

/** A live, authenticated connection: a device or one companion-app session of a user. */
export interface Peer extends PeerInfo {
  /** Party key used in call rooms: `dev:<id>` or `usr:<id>`. */
  key: string;
  conn: Conn;
}

interface DevicePeer extends Peer {
  kind: "device";
  hook: "up" | "down";
  /** The notice this phone was last sent (`<id>:<audio token>`), "" = none. Not persisted. */
  noticeSig?: string;
}

const infoOf = ({ key: _key, conn: _conn, ...info }: Peer): PeerInfo => info;

/**
 * The far end of a call with another household (host '') or another server. It has no socket:
 * call signaling for it goes to `env.calls`, in order. Ringing and ICE configuration stay local
 * (each side rings its own people and uses its own TURN).
 */
class FedConn implements Conn {
  /** Signals go out in order; a call's successor (after a transfer) shares the line. */
  private line: { chain: Promise<void> } = { chain: Promise.resolve() };
  private readonly env: ServerEnv;
  readonly to: { host: string; householdId?: string };
  private leg: string | undefined;
  private readonly offers: boolean;
  /** Someone calling our public line: `ringing` (queue updates) goes to them too. */
  private readonly lineCaller: boolean;

  constructor(
    env: ServerEnv,
    to: { host: string; householdId?: string },
    leg?: string,
    offers = false,
    lineCaller = false,
  ) {
    this.env = env;
    this.to = to;
    this.leg = leg;
    this.offers = offers;
    this.lineCaller = lineCaller;
  }

  /** Our caller would rather leave a voicemail than wait in the far line's queue. */
  voicemail(callId: string): void {
    const calls = this.env.calls;
    if (!calls) return;
    const signal: FedSignal = { t: "call.voicemail", callId: this.leg ?? callId };
    this.line.chain = this.line.chain
      .then(() => calls.signal(this.to, signal))
      .catch((e) => this.env.log("warn", "federated signal failed", { error: String(e) }));
  }

  /** Our caller would rather be called back than wait in the far line's queue. */
  callback(callId: string): void {
    const calls = this.env.calls;
    if (!calls) return;
    const signal: FedSignal = { t: "call.callback", callId: this.leg ?? callId };
    this.line.chain = this.line.chain
      .then(() => calls.signal(this.to, signal))
      .catch((e) => this.env.log("warn", "federated signal failed", { error: String(e) }));
  }

  /** Keeps signals of a transferred call and its successor in one order. */
  shareLine(other: FedConn): void {
    this.line = other.line;
  }

  /** A call that became a room goes on under the same id (see `merge`). */
  useLeg(leg: string): void {
    this.leg ??= leg;
  }

  /** A room message to or from a participant on the other side (`room.signal`, by leg). */
  room(msg: RoomSignalMsg): void {
    const calls = this.env.calls;
    const leg = this.leg;
    if (!calls || !leg) return;
    this.line.chain = this.line.chain
      .then(() => calls.signal(this.to, { t: "room.signal", callId: leg, msg }))
      .catch((e) => this.env.log("warn", "room signal failed", { error: String(e) }));
  }

  send(msg: ServerToDevice | ServerToApp): void {
    if (isRoomMessage(msg)) {
      this.room(msg as RoomSignalMsg);
      return;
    }
    if (
      msg.t !== "call.state" &&
      msg.t !== "rtc.sdp" &&
      msg.t !== "rtc.ice" &&
      msg.t !== "call.key"
    )
      return;
    if (msg.t === "call.state" && msg.state === "ringing" && !this.lineCaller) return;
    // A voicemail offer never crosses to the other server, except to a Lounge phone there where
    // one of our accounts is a guest, and to someone whose call our team/org space transferred
    // (their server relays it to them; see `relayOffer`).
    if (msg.t === "call.state" && msg.voicemail && !this.offers) {
      const { voicemail: _vm, ...rest } = msg;
      msg = rest;
    }
    const calls = this.env.calls;
    if (!calls) return;
    // The far end knows this call by its own id (a leg of a relayed call).
    const signal = (this.leg ? { ...msg, callId: this.leg } : msg) as FedSignal;
    this.line.chain = this.line.chain
      .then(() => calls.signal(this.to, signal))
      .catch((e) => this.env.log("warn", "federated signal failed", { error: String(e) }));
  }

  close(): void {}
}

const partyOf = (a: Account): Party => ({ handle: a.handle, id: a.id, name: a.name });

/** Room messages (and a mesh room's `rtc.*`, which name a `peer`) travel as `room.signal`. */
function isRoomMessage(msg: { t: string; peer?: string }): boolean {
  if (msg.t === "rtc.sdp" || msg.t === "rtc.ice") return msg.peer !== undefined;
  return msg.t.startsWith("room.") && msg.t !== "rooms.changed";
}

/** One of our people in a room held elsewhere (another household here, or another server). */
interface RoomLeg {
  leg: string;
  /** The room's id there, once known (from its first `room.state`). */
  roomId?: string;
  peer: Peer;
  conn: FedConn;
  joinedAt: number;
  /** Their account: this server meters their room minutes. */
  payer?: string;
}

type LoungeEndReason = "logout" | "left" | "idle" | "replaced" | "removed" | "offline";
type LoungeFail = "expired" | "wrong_key" | "timeout" | "busy" | "not_found";

/** Something on a Lounge phone's speed-dial while a person uses it. */
interface LoungeEntry {
  /**
   * `connection`: someone in another household or on another server (by connection id);
   * `address`: a guest's speed-dial entry, dialed through the guest's own server;
   * `line`: a public line (`id` is its address) from the person's own phone's keys.
   */
  kind: "user" | "device" | "connection" | "address" | "line";
  id: string;
  label: string;
}

/**
 * The person a phone stands for: whoever is using a Lounge phone right now, or the owner of a
 * personal phone. Calls to that person ring the phone; household phones stand for nobody.
 */
const personOf = (d: PeerInfo): string | undefined => d.lounge?.session?.userId ?? d.owner;

/** A random key (button index 0–9) for the proximity proof. */
function randomKey(): number {
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b);
  while ((b[0] as number) >= 250);
  return (b[0] as number) % 10;
}

interface Room {
  id: string;
  state: RoomState;
  /** The account whose fair-use allowance the call's minutes count against. */
  payer?: string;
  /** When media started flowing (for metering). */
  activeAt?: number;
  /** For the call log. */
  startedAt?: number;
  answered?: boolean;
  /**
   * Also ringing for the callee elsewhere: their other spaces on this server and a Lounge phone
   * they're a guest at on another server. The first to answer becomes `calleePeer`.
   */
  branches?: Peer[];
  caller: Peer;
  /** Known once the callee is a device (immediately) or a user answers from one session. */
  calleePeer?: Peer;
  cancelTimer?: () => void;
  /** Where the caller can leave a message if the call goes unanswered, and as whom. */
  vm?: { target: VmTarget; from: VmCaller };
  /** A house-line key ringing several members (callee key `grp:…`): the first to answer. */
  group?: string[];
  /** On hold: the party key of whoever put it on hold. */
  heldBy?: string;
  /** A call to a ring group (callee key `hg:…`): its steps and where it is (see `huntNext`). */
  hunt?: HuntState;
  /** Recording announced: by this space (`ours`), or by the far side's. */
  recording?: { by: string; ours: boolean };
  /** Never recorded here (we called a kids' phone elsewhere). */
  noRecording?: boolean;
  /** The far server's explanation for ending it (e.g. it doesn't take recorded calls). */
  endNote?: string;
  /** A call to one of our public lines: its place in the queue (see `pumpLines`). */
  line?: LineCallState;
  /** The line's longest-wait timer. */
  cancelWait?: () => void;
  /** A call to a public line elsewhere: queue updates and its voicemail offer pass through. */
  farLine?: boolean;
  /** The caller asked a public line to call them back: their place is kept until then. */
  callbackUntil?: number;
  /** Rings a person here for a call another household here owns: its missed call is theirs. */
  branchLeg?: boolean;
  /**
   * A call with one of our add-ons within one of its shares: into it (`grantId`: the caller's
   * grant), or from it to someone holding it (or its owner). Revoking the grant, or the add-on
   * dropping the share, ends it.
   */
  addonShare?: { id: string; label: string; grantId?: string };
  /** TURN usernames handed out for this call (revoked when it ends, where the host can). */
  turnUsers?: string[];
}

/** A public line calling one of our people back, ringing their apps and phones. */
interface CallbackRinging {
  req: CallbackRing;
  targets: Peer[];
  cancel?: () => void;
  /** Answered or missed: waiting for the line's server, ignore more replies. */
  done?: boolean;
}

/** One place in a public line's queue: a caller on the line, or one waiting for a call back. */
type QueueSlot =
  | { kind: "room"; callId: string; since: number; room: Room }
  | { kind: "callback"; callId: string; since: number; row: LineCallback };

/** Someone signed in at another Lounge phone and open to chat ("who's here"). */
type Here = { name: string; where: string };

const deviceKey = (id: string) => `dev:${id}`;
const userKey = (id: string) => `usr:${id}`;
const addonKey = (id: string) => `addon:${id}`;
const HOUR_MS = 60 * 60 * 1000;

/** Why a call with an add-on ended at its longest (limits.ts `addonCallMinutes`). */
export const ADDON_CALL_LIMIT_NOTE = "Calls with add-ons end after a few hours.";

/** `handle+name@host` → `handle+name+share@host`. */
const withShare = (address: string, share: string) => address.replace("@", `+${share}@`);

/** An add-on calling, as another hub here is told (its share's address and label, if any). */
function addonOf(room: Room): { name: string; address: string; share?: string } {
  const addon = room.caller.addon as NonNullable<Peer["addon"]>;
  const share = room.addonShare;
  if (share && room.caller.kind === "addon") {
    return { name: addon.name, address: withShare(addon.address, share.id), share: share.label };
  }
  return {
    name: addon.name,
    address: addon.address,
    ...(addon.share ? { share: addon.share } : {}),
  };
}

/** `call.ringing.from` for a call from an add-on (with its share), or nothing. */
function addonFrom(room: Room): { address?: string; kind?: "addon"; share?: string } {
  if (!room.caller.addon) return {};
  const a = addonOf(room);
  return { address: a.address, kind: "addon", ...(a.share ? { share: a.share } : {}) };
}

/** An add-on of ours, or the far end of a call that is someone's add-on elsewhere. */
const isAddonParty = (p: Peer | undefined): boolean => p?.kind === "addon" || !!p?.addon;

/**
 * All live connections and calls for one household. Calls never cross households, so this is the
 * unit of coordination: an in-process object when self-hosting, one Durable Object on Cloudflare.
 *
 * Signaling is peer-to-peer: the hub relays `rtc.*` between the two parties and the party that
 * placed the call sends the SDP offer.
 */
export class HouseholdHub {
  private readonly devices = new Map<string, DevicePeer>();
  /** Connected add-ons of this household (docs/add-ons.md), by add-on id. */
  private readonly addonPeers = new Map<string, Peer>();
  /** Test connection: tests waiting for their add-on's `addon.test.ok`, by test id. */
  private readonly addonTests = new Map<
    string,
    { addonId: string; sentAt: number; done(r: AddonTestResult): void }
  >();
  /** Labs check-in alerts sent, by phone (at most one in 12 hours each). */
  private readonly checkinAlerts = new Map<string, number>();
  /** Chimes posted, by phone (at most one a minute each). */
  private readonly chimed = new Map<string, number>();
  private readonly apps = new Map<string, Set<Peer>>();
  private readonly rooms = new Map<string, Room>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Timer standing in for `wakeAt` on hosts without one. */
  private cancelWakeTimer?: () => void;
  private roomsDirty = false;
  /** Lounge phones' key-proof and idle timers, by device id. */
  private readonly loungeTimers = new Map<string, { proof?: () => void; idle?: () => void }>();
  /** When this hub last deleted expired history (see `maybeSweep`). */
  private lastSweep = 0;
  /** Party lines, phone rooms and 3-way calls held here. */
  private readonly conf: LiveRooms;
  /** Our people in rooms held elsewhere, by leg id. */
  private readonly legs = new Map<string, RoomLeg>();
  private confDirty = false;
  /**
   * Calls handed over to a new id by a transfer (`<host>|<their old call id>` → the new call
   * here): if their server ends the old call instead of following, the new one ends too.
   */
  private readonly handoffs = new Map<string, string>();
  /** Party lines with hours: the closing each room's people were warned of (by room id). */
  private readonly closingWarned = new Map<string, number>();
  /** Lines calling our people back right now, by the call id they waited under. */
  private readonly callbackRings = new Map<string, CallbackRinging>();
  /** Some line of ours may have callers waiting for a call back (checked in the store). */
  private callbacksPending = true;

  readonly householdId: string;
  private readonly env: ServerEnv;

  constructor(householdId: string, env: ServerEnv) {
    this.householdId = householdId;
    this.env = env;
    this.conf = new LiveRooms({
      env,
      householdId,
      run: (fn) => this.run(fn),
      changed: () => {
        this.confDirty = true;
      },
      reschedule: () => void this.scheduleWake(),
      announce: (room) => this.announceRoom(room),
      remote: (info) => this.remoteFromInfo(info),
      recordingBy: (room) => this.recordingBy([...room.participants.values()].map((p) => p.peer)),
      recordingTicket: async (room, p) =>
        this.env.store.recordings.createTicket(
          {
            householdId: this.householdId,
            kind: "room",
            callId: room.id,
            accountId: await this.recorderAccount(p.peer),
            peer: `room:${room.id}`,
            peerLabel: room.name,
            startedAt: this.env.now(),
          },
          this.env.now(),
        ),
    });
  }

  /** Serializes all state changes so concurrent messages cannot interleave mid-update. */
  private run<T>(fn: () => Promise<T> | T): Promise<T> {
    const task = async () => {
      try {
        return await fn();
      } finally {
        this.flushRooms();
      }
    };
    const next = this.queue.then(task, task);
    this.queue = next.catch((e) => this.env.log("error", "hub task failed", { error: String(e) }));
    return next;
  }

  /**
   * Deletes the space's expired history now and then, piggybacking on activity (a phone or app
   * connecting, a call ending) rather than a timer of its own, so an idle space can sleep.
   */
  private maybeSweep(): void {
    const now = this.env.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    this.env.defer(
      sweepSpace(this.env, this.householdId).catch((e) =>
        this.env.log("warn", "history sweep failed", { error: String(e) }),
      ),
    );
  }

  private remember(peer: Peer): void {
    peer.conn.remember?.({ kind: "peer", peer: infoOf(peer) });
  }

  private flushRooms(): void {
    if (this.confDirty && this.env.saveConferences) {
      this.confDirty = false;
      this.env.saveConferences(this.householdId, this.snapshotConferences());
    }
    if (!this.roomsDirty || !this.env.saveRooms) return;
    this.roomsDirty = false;
    this.env.saveRooms(this.householdId, this.snapshotRooms());
  }

  snapshotConferences(): ConferenceSnapshot {
    return {
      rooms: this.conf.snapshot(),
      legs: [...this.legs.values()].map((l) => ({
        leg: l.leg,
        ...(l.roomId ? { roomId: l.roomId } : {}),
        session: l.peer.session,
        to: l.conn.to,
        joinedAt: l.joinedAt,
        ...(l.payer ? { payer: l.payer } : {}),
      })),
    };
  }

  snapshotRooms(): RoomSnapshot[] {
    return [...this.rooms.values()].map((r) => {
      const remotes = [r.caller, r.calleePeer].filter((p): p is Peer => p?.kind === "remote");
      return {
        id: r.id,
        state: r.state,
        ...(r.payer ? { payer: r.payer } : {}),
        ...(r.activeAt !== undefined ? { activeAt: r.activeAt } : {}),
        ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
        ...(r.answered ? { answered: true } : {}),
        ...(r.vm ? { vm: r.vm } : {}),
        ...(r.group ? { group: r.group } : {}),
        ...(r.heldBy ? { heldBy: r.heldBy } : {}),
        ...(r.hunt ? { hunt: r.hunt } : {}),
        ...(r.recording ? { recording: r.recording } : {}),
        ...(r.noRecording ? { noRecording: true } : {}),
        ...(r.line ? { line: r.line } : {}),
        ...(r.farLine ? { farLine: true } : {}),
        ...(r.branchLeg ? { branchLeg: true } : {}),
        ...(r.addonShare ? { addonShare: r.addonShare } : {}),
        ...(r.turnUsers?.length ? { turnUsers: r.turnUsers } : {}),
        caller: r.caller.session,
        ...(r.calleePeer ? { callee: r.calleePeer.session } : {}),
        ...(remotes.length ? { remotes: remotes.map(infoOf) } : {}),
        ...(r.branches?.length ? { branches: r.branches.map(infoOf) } : {}),
      };
    });
  }

  /**
   * Rebuilds live state after the host slept: re-registers authenticated connections and the
   * rooms that referenced them. Sends nothing. Returns the peers in input order.
   */
  restore(
    entries: { info: PeerInfo; conn: Conn }[],
    rooms: RoomSnapshot[],
    conferences?: ConferenceSnapshot,
  ): Peer[] {
    const peers = entries.map(({ info, conn }) => {
      const peer: Peer = {
        ...info,
        key:
          info.kind === "device"
            ? deviceKey(info.id)
            : info.kind === "addon"
              ? addonKey(info.id)
              : userKey(info.id),
        conn,
      };
      if (peer.kind === "addon") {
        this.addonPeers.set(peer.id, peer);
      } else if (peer.kind === "device") {
        const device = peer as DevicePeer;
        device.hook ??= "down";
        this.devices.set(peer.id, device);
      } else {
        const set = this.apps.get(peer.id) ?? new Set<Peer>();
        this.apps.set(peer.id, set);
        set.add(peer);
      }
      return peer;
    });
    const bySession = new Map(peers.map((p) => [p.session, p]));
    for (const snap of rooms) {
      for (const info of snap.remotes ?? []) bySession.set(info.session, this.remoteFromInfo(info));
      const caller = bySession.get(snap.caller);
      if (!caller || snap.state.phase === "ended") continue;
      const calleePeer = snap.callee ? bySession.get(snap.callee) : undefined;
      if (snap.callee && !calleePeer) continue;
      this.rooms.set(snap.id, {
        id: snap.id,
        state: snap.state,
        ...(snap.branches?.length
          ? { branches: snap.branches.map((b) => this.remoteFromInfo(b)) }
          : {}),
        ...(snap.payer ? { payer: snap.payer } : {}),
        ...(snap.activeAt !== undefined ? { activeAt: snap.activeAt } : {}),
        ...(snap.startedAt !== undefined ? { startedAt: snap.startedAt } : {}),
        ...(snap.answered ? { answered: true } : {}),
        ...(snap.vm ? { vm: snap.vm } : {}),
        ...(snap.group ? { group: snap.group } : {}),
        ...(snap.heldBy ? { heldBy: snap.heldBy } : {}),
        ...(snap.hunt ? { hunt: snap.hunt } : {}),
        ...(snap.recording ? { recording: snap.recording } : {}),
        ...(snap.noRecording ? { noRecording: true } : {}),
        ...(snap.line ? { line: snap.line } : {}),
        ...(snap.farLine ? { farLine: true } : {}),
        ...(snap.branchLeg ? { branchLeg: true } : {}),
        ...(snap.addonShare ? { addonShare: snap.addonShare } : {}),
        ...(snap.turnUsers?.length ? { turnUsers: snap.turnUsers } : {}),
        caller,
        ...(calleePeer ? { calleePeer } : {}),
      });
    }
    // Callers waiting in a public line's queue keep their place and their longest wait.
    for (const room of this.rooms.values()) if (room.line) this.armWait(room);
    if (conferences) {
      const byPeerSession = new Map(peers.map((p) => [p.session, p]));
      this.conf.restore(conferences.rooms, byPeerSession);
      for (const l of conferences.legs) {
        const peer = byPeerSession.get(l.session);
        if (!peer) continue;
        this.legs.set(l.leg, {
          leg: l.leg,
          ...(l.roomId ? { roomId: l.roomId } : {}),
          peer,
          conn: new FedConn(this.env, l.to, l.leg),
          joinedAt: l.joinedAt,
          ...(l.payer ? { payer: l.payer } : {}),
        });
      }
      this.confDirty = true;
    }
    this.roomsDirty = true;
    this.flushRooms();
    for (const d of this.devices.values()) if (d.lounge) this.rearmLounge(d);
    return peers;
  }

  // --- connections ----------------------------------------------------------

  connectDevice(device: Device, conn: Conn, features?: readonly string[]): Promise<Peer> {
    return this.run(async () => {
      const old = this.devices.get(device.id);
      if (old) {
        this.dropPeer(old, true);
        old.conn.close(CloseCode.replaced, "replaced by a newer connection");
      }
      const peer: DevicePeer = {
        session: newId("s"),
        householdId: this.householdId,
        kind: "device",
        id: device.id,
        key: deviceKey(device.id),
        label:
          deviceMode(device) === "left"
            ? leftPhoneName(device.name, device.leftBy ?? "")
            : device.name,
        conn,
        guardian: false,
        hook: "down",
        ...(device.ownerUserId ? { owner: device.ownerUserId } : {}),
        ...(deviceMode(device) === "left" ? { left: device.leftBy ?? "" } : {}),
        ...(device.kind === "lounge" ? { lounge: { nonce: "", nonceExpiresAt: 0 } } : {}),
        ...(device.model && RECORDING_MODELS.has(device.model) ? { canRecord: true } : {}),
        ...(features?.length ? { features: [...features] } : {}),
      };
      // Back within the grace period: the session carries on (a replaced socket hands it over).
      const resumed = peer.lounge ? await this.resumeLounge(peer, old) : undefined;
      const wasOnline = device.ownerUserId ? this.userOnline(device.ownerUserId) : true;
      this.devices.set(device.id, peer);
      if (resumed) {
        conn.send({ t: "lounge.session", name: resumed.name, openToChat: resumed.openToChat });
      }
      await this.sendConfig(peer, true);
      await this.refreshNotice(peer);
      this.remember(peer);
      if (peer.lounge) this.issueNonce(peer);
      this.broadcastStatus(peer, true);
      if (device.ownerUserId && !wasOnline) await this.announceMember(device.ownerUserId);
      if (resumed) {
        await this.announceMember(resumed.userId);
        await this.touchIdle(peer);
      }
      await this.scheduleWake();
      this.maybeSweep();
      this.kickLines();
      return peer;
    });
  }

  connectApp(user: User, conn: Conn, auth?: string): Promise<Peer> {
    return this.run(async () => {
      const peer: Peer = {
        session: newId("s"),
        householdId: this.householdId,
        kind: "user",
        id: user.id,
        key: userKey(user.id),
        label: user.name,
        conn,
        guardian: user.role === "guardian",
        ...(auth ? { auth } : {}),
      };
      const set = this.apps.get(user.id) ?? new Set<Peer>();
      const cameOnline = set.size === 0 && !this.userOnline(user.id);
      this.apps.set(user.id, set);
      set.add(peer);
      this.remember(peer);
      conn.send({ t: "app.ready", userId: user.id, server: serverInfo(this.env) });
      // Everyone's presence for this session, then tell the others this person is online.
      const available = await this.env.store.availability(this.householdId);
      for (const [userId, avail] of available) {
        if (userId === user.id) continue;
        conn.send(this.memberMessage(userId, avail));
      }
      if (cameOnline) this.broadcastMember(user.id, available.get(user.id) ?? true);
      this.kickLines();
      for (const d of await this.env.store.listDevices(this.householdId)) {
        // Everyone sees the Lounge phones (and who is at them).
        if (!peer.guardian && d.ownerUserId !== user.id && d.kind !== "lounge") continue;
        const live = this.devices.get(d.id);
        conn.send(this.statusMessage(d.id, live, d.lastSeen ?? 0));
      }
      this.maybeSweep();
      return peer;
    });
  }

  disconnect(peer: Peer): Promise<void> {
    return this.run(() => this.dropPeer(peer));
  }

  /** `replaced`: a newer connection of the same device takes over (and any Lounge session). */
  private dropPeer(peer: Peer, replaced = false): void {
    if (peer.kind === "device") {
      if (this.devices.get(peer.id) !== peer) return;
      this.devices.delete(peer.id);
      this.clearLoungeTimers(peer.id);
      let session = replaced ? undefined : peer.lounge?.session;
      const now = this.env.now();
      if (session?.guest) {
        // A guest's session doesn't wait for the phone to come back.
        const guest = session.guest;
        void this.env.store.endLoungeSession(session.id, "offline", now);
        this.notifyGuest(guest, peer.id, { step: "ended", reason: "offline" });
        session = undefined;
      }
      if (session) {
        // Not over yet: the phone has LOUNGE_RECONNECT_GRACE_MS to come back (see wake()).
        void this.env.store
          .setLoungeOffline(session.id, now)
          .then(() => this.scheduleWake())
          .catch((e) => this.env.log("error", "lounge offline failed", { error: String(e) }));
        void this.announceMember(session.userId);
      }
      if (peer.owner && !this.userOnline(peer.owner)) void this.announceMember(peer.owner);
      this.broadcastStatus(peer as DevicePeer, false);
      if (this.devices.size === 0 && !session) void this.scheduleWake();
    } else if (peer.kind === "addon") {
      if (this.addonPeers.get(peer.id) !== peer) return;
      this.addonPeers.delete(peer.id);
    } else {
      const set = this.apps.get(peer.id);
      if (!set?.delete(peer)) return;
      if (set.size === 0) {
        this.apps.delete(peer.id);
        if (!this.userOnline(peer.id)) void this.announceMember(peer.id);
      }
    }
    void this.conf.dropPeer(peer);
    for (const leg of [...this.legs.values()]) {
      if (leg.peer === peer) void this.endLeg(leg, "left", { tellRoom: true, tellPeer: false });
    }
    for (const room of [...this.rooms.values()]) {
      if (room.caller === peer) {
        void this.apply(room, { type: "hangup", by: room.state.caller });
      } else if (room.calleePeer === peer) {
        void this.apply(room, { type: "hangup", by: room.state.callee });
      } else if (!room.calleePeer && !room.line?.waiting && this.ringTargets(room).length === 0) {
        // The last session or phone that was ringing for the callee went away (a ring group
        // moves on to its next step).
        if (room.hunt) void this.huntNext(room);
        else void this.apply(room, { type: "timeout" });
      }
    }
  }

  isOnline(deviceId: string): boolean {
    return this.devices.has(deviceId) || this.addonPeers.has(deviceId);
  }

  // --- inbound messages -----------------------------------------------------

  handleDevice(peer: Peer, msg: DeviceToServer): Promise<void> {
    return this.run(async () => {
      if (peer.kind === "addon") return this.handleAddon(peer, msg);
      const device = this.devices.get(peer.id);
      if (device !== peer) return; // stale connection
      switch (msg.t) {
        case "hook":
          device.hook = msg.state;
          this.remember(device);
          if (device.lounge) await this.touchIdle(device);
          if (msg.state === "down") this.kickLines();
          return;
        case "button": {
          // A key on a later page (`key-pages`): stored as (page - 1) * 10 + slot.
          if (msg.page !== undefined && msg.index >= KEYS_PER_PAGE) {
            return this.refuse(device, "denied");
          }
          return this.deviceDial(device, keyIndex(msg.page ?? 1, msg.index));
        }
        case "call.extension":
          return this.extensionDial(device, msg.number);
        case "call.address":
          // Phones dial with their keys (an add-on's address can be on one).
          return this.refuse(device, "unavailable");
        case "call.key":
          return this.callKey(peer, msg);
        case "lounge.press":
          return this.loungePress(device, msg.index);
        case "lounge.leave":
          return this.endLoungeSession(device, "logout");
        case "lounge.refresh":
          // The phone is showing its code and needs a (new) one. Not during a key proof.
          if (device.lounge && !device.lounge.challenge) this.issueNonce(device);
          return;
        case "lounge.chat": {
          const session = device.lounge?.session;
          if (!session) return;
          session.openToChat = msg.open;
          this.remember(device);
          await this.env.store.setLoungeChat(session.id, msg.open);
          device.conn.send({ t: "lounge.session", name: session.name, openToChat: msg.open });
          await this.announceMember(session.userId);
          await this.refreshIdleLounges();
          return;
        }
        case "greeting.begin":
        case "greeting.reset":
          return this.greetingFromPhone(device, msg);
        case "voicemail.fetch":
          return this.voicemailFetch(device);
        case "checkin.ok":
          return this.checkinOk(device);
        case "notice.chime":
          return this.chime(device);
        case "checkin.missed":
          return this.checkinMissed(device, msg.by);
        case "voicemail.heard":
          return this.voicemailHeard(device, msg.id);
        case "missed.clear":
          return this.missedClear(device);
        case "call.back":
          return this.callBackMissed(device, msg.id);
        case "status":
          device.status = msg;
          this.remember(device);
          this.broadcastStatus(device, true);
          return;
        case "ping":
          peer.conn.send({ t: "pong" });
          return;
        case "call.answer":
        case "call.hangup":
          return this.callMessage(peer, msg);
        case "rtc.sdp":
        case "rtc.ice":
          if (msg.peer) return this.roomMessage(peer, msg);
          return this.callMessage(peer, msg);
        case "call.hold":
          return this.hold(peer, msg.callId, msg.hold);
        case "call.merge":
          return this.merge(peer, msg.callId, msg.with);
        case "call.transfer":
          return this.transfer(peer, msg);
        case "call.voicemail":
          return this.lineVoicemail(peer, msg.callId);
        case "call.callback":
          return this.lineCallback(peer, msg.callId);
        case "notice.dismiss":
          await this.env.store.notices.dismiss(msg.id, device.id, this.env.now());
          return this.refreshNotice(device);
        case "room.leave":
        case "room.mute":
        case "room.remove":
        case "room.lock":
        case "room.talk":
        case "room.here":
        case "room.media":
          return this.roomMessage(peer, msg);
        default:
          peer.conn.send({
            t: "error",
            code: "bad_message",
            message: `unexpected ${msg.t}`,
            ...(msg.id ? { ref: msg.id } : {}),
          });
      }
    });
  }

  handleApp(peer: Peer, msg: AppToServer): Promise<void> {
    return this.run(async () => {
      if (!this.apps.get(peer.id)?.has(peer)) return;
      switch (msg.t) {
        case "call.dial":
          return this.appDial(peer, msg.deviceId);
        case "call.extension":
          return this.extensionDial(peer, msg.number);
        case "call.user":
          return this.userDial(peer, msg.userId);
        case "call.connection":
          return this.connectionDial(peer, msg.connectionId);
        case "call.phone":
          return this.connectionPhoneDial(peer, msg.connectionId, msg.deviceId);
        case "presence.set":
          await this.env.store.setAvailable(peer.id, msg.available);
          this.broadcastMember(peer.id, msg.available);
          if (msg.available) this.kickLines();
          return;
        case "call.line":
          return this.lineDial(peer, msg.address);
        case "call.address": {
          const addon = parseAddonAddress(msg.address);
          return addon
            ? this.addonDial(peer, addon)
            : this.refuse(peer, "unavailable", CANT_CALL_NOTE);
        }
        case "call.key":
          return this.callKey(peer, msg);
        case "lounge.claim":
          return this.loungeClaim(peer, msg.deviceId, msg.nonce);
        case "lounge.leave": {
          const device = this.devices.get(msg.deviceId);
          const session = device?.lounge?.session;
          // Your own session, or (guardians) anyone's.
          if (!device || !session || (session.userId !== peer.id && !peer.guardian)) {
            peer.conn.send({ t: "error", code: "not_found", message: "no such session" });
            return;
          }
          return this.endLoungeSession(device, "left");
        }
        case "ping":
          peer.conn.send({ t: "pong" });
          return;
        case "call.answer":
        case "call.hangup":
          return this.callMessage(peer, msg);
        case "rtc.sdp":
        case "rtc.ice":
          if (msg.peer) return this.roomMessage(peer, msg);
          return this.callMessage(peer, msg);
        case "call.hold":
          return this.hold(peer, msg.callId, msg.hold);
        case "call.merge":
          return this.merge(peer, msg.callId, msg.with);
        case "call.transfer":
          return this.transfer(peer, msg);
        case "call.voicemail":
          return this.lineVoicemail(peer, msg.callId);
        case "call.callback":
          return this.lineCallback(peer, msg.callId);
        case "room.join":
          if (msg.roomId) return this.joinById(peer, msg.roomId);
          return this.joinByAddress(peer, msg.address ?? "");
        case "room.leave":
        case "room.mute":
        case "room.remove":
        case "room.lock":
        case "room.talk":
        case "room.here":
        case "room.media":
          return this.roomMessage(peer, msg);
        default:
          peer.conn.send({
            t: "error",
            code: "bad_message",
            message: `unexpected ${msg.t}`,
            ...(msg.id ? { ref: msg.id } : {}),
          });
      }
    });
  }

  /**
   * A removed phone is told to wipe itself (it then shows "Set me up" again). One that is offline
   * gets the same message when it next connects (see `Gateway`, `removed_devices`).
   */
  forgetDevice(deviceId: string): Promise<void> {
    return this.run(() => {
      const peer = this.devices.get(deviceId) ?? this.addonPeers.get(deviceId);
      if (!peer) return;
      peer.conn.send({ t: "wipe", reason: "removed" });
      this.dropPeer(peer);
      peer.conn.close(CloseCode.unauthorized, "removed");
    });
  }

  /** Re-send config to a device after guardians change settings (incl. quiet hours). */
  refreshDevice(deviceId: string): Promise<void> {
    return this.run(async () => {
      const addonPeer = this.addonPeers.get(deviceId);
      if (addonPeer) return this.recheckAddon(addonPeer);
      const peer = this.devices.get(deviceId);
      if (!peer) return;
      // Name or owner may have changed (e.g. "make this my phone").
      const device = await this.env.store.getDevice(deviceId);
      const session = peer.lounge?.session;
      if (session && !(await this.env.store.getUser(session.userId))) {
        await this.endLoungeSession(peer, "removed");
      }
      if (device) {
        const before = peer.owner;
        peer.label =
          deviceMode(device) === "left"
            ? leftPhoneName(device.name, device.leftBy ?? "")
            : device.name;
        if (device.ownerUserId) peer.owner = device.ownerUserId;
        else delete peer.owner;
        if (deviceMode(device) === "left") peer.left = device.leftBy ?? "";
        else delete peer.left;
        this.remember(peer);
        if (before !== peer.owner) {
          for (const u of [before, peer.owner]) if (u) await this.announceMember(u);
          this.broadcastStatus(peer, true);
        }
      }
      await this.sendConfig(peer, true);
      if (peer.lounge) await this.touchIdle(peer);
      await this.scheduleWake();
      // Permissions changed: people on Lounge phones may have gained or lost a key.
      for (const d of this.devices.values()) {
        if (d !== peer && d.lounge?.session) await this.sendConfig(d, true);
      }
    });
  }

  /** Sends a message to every connected guardian session (e.g. `voicemail.new`). */
  announce(msg: ServerToApp): Promise<void> {
    return this.run(() => {
      for (const set of this.apps.values()) {
        for (const app of set) if (app.guardian) app.conn.send(msg);
      }
    });
  }

  /** Sends a message to every open companion session of one member. */
  sendToUser(userId: string, msg: ServerToApp): Promise<void> {
    return this.run(() => {
      for (const app of this.apps.get(userId) ?? []) app.conn.send(msg);
    });
  }

  /**
   * Closes a member's companion sockets (signed out, or no longer in this space): nothing keeps
   * working on a socket opened before. See `Coordinator.closeApps`.
   */
  closeApps(userId: string, filter: AppCloseFilter = {}): Promise<void> {
    return this.run(() => {
      for (const app of [...(this.apps.get(userId) ?? [])]) {
        if (filter.only && !(app.auth && filter.only.includes(app.auth))) continue;
        if (filter.except !== undefined && app.auth === filter.except) continue;
        this.dropPeer(app);
        if (filter.removed) app.conn.close(CloseCode.removed, filter.reason ?? "not in this space");
        else {
          app.conn.send({ t: "error", code: "unauthorized", message: "signed out" });
          app.conn.close(CloseCode.unauthorized, "signed out");
        }
      }
    });
  }

  /** Called by hosts that implement `wakeAt`, at the requested time. */
  wake(): Promise<void> {
    return this.run(() => this.catchUp(false));
  }

  /**
   * The space's name or time zone changed: every phone gets fresh config now (its clock, quiet
   * status and owner line), and everything timed by the space's clock (quiet hours, Lounge end of
   * day, party line hours, public lines' hours for call backs) is checked and scheduled again.
   */
  spaceChanged(): Promise<void> {
    return this.run(() => this.catchUp(true));
  }

  /** What the hub's alarm does; `force` re-sends every phone's config even if quiet didn't change. */
  private async catchUp(force: boolean): Promise<void> {
    for (const d of this.devices.values()) await this.sendConfig(d, force);
    await this.expireOfflineLounges();
    await this.endDayEndSessions();
    await this.env.flushPresence?.(this.householdId);
    await this.conf.sweepIdle(this.env.now());
    // Call backs: a ring that ran out, a place that expired, someone free to call back.
    this.callbacksPending = true;
    await this.pumpLines();
    // Notices: one that expired leaves the phones.
    await this.updateNotices();
    // Daily check-ins: a time passed without I'm OK.
    await this.checkCheckins();
    // Calls with add-ons that reached their longest length.
    await this.endLongAddonCalls();
    // Party lines with hours: opening, closing soon, closed.
    await this.checkRoomHours();
    await this.scheduleWake();
  }

  // --- dialing ----------------------------------------------------------------

  /** In a call (ringing, held or live) or in a room: not to be rung. */
  private busy(key: string): boolean {
    for (const r of this.rooms.values()) {
      if (r.state.caller === key || r.state.callee === key) return true;
    }
    if (this.conf.inRoom(key)) return true;
    for (const l of this.legs.values()) if (l.peer.key === key) return true;
    return false;
  }

  /**
   * Call waiting (docs/phone-ux.md): where a busy callee may be rung softly instead of refused as
   * busy. Only the session in their one answered call (an app, or a phone that lists
   * `call-waiting`), when that call isn't on hold, nothing else rings for them, they're in no
   * room, and their setting is on (a person's own, or a household phone's guardians'). Quiet
   * hours and allow-lists were checked before, exactly as for a first call.
   */
  private async waitingRing(calleeKey: string): Promise<Peer[]> {
    if (this.conf.inRoom(calleeKey)) return [];
    for (const l of this.legs.values()) if (l.peer.key === calleeKey) return [];
    const theirs = [...this.rooms.values()].filter(
      (r) => r.state.caller === calleeKey || r.state.callee === calleeKey,
    );
    const r = theirs.length === 1 ? theirs[0] : undefined;
    if (r?.state.phase !== "active" || r.heldBy) return [];
    const peer = r.state.caller === calleeKey ? r.caller : r.calleePeer;
    if (!peer) return [];
    const can =
      peer.kind === "user" || (peer.kind === "device" && !!peer.features?.includes("call-waiting"));
    if (!can) return [];
    const owner = await this.waitingOwner(calleeKey, peer);
    if (!owner || !(await this.env.store.callWaiting(owner))) return [];
    return [peer];
  }

  /** Whose call-waiting setting applies: the person's, or a household phone's own. */
  private async waitingOwner(calleeKey: string, peer: Peer): Promise<VoicemailOwner | undefined> {
    const { store } = this.env;
    const userId = calleeKey.startsWith("usr:")
      ? idOf(calleeKey)
      : peer.kind === "device"
        ? personOf(peer)
        : undefined;
    if (userId && !userId.startsWith("guest:")) {
      const user = await store.getUser(userId);
      return user ? { accountId: user.accountId } : undefined;
    }
    if (peer.kind === "device" && !(peer as DevicePeer).lounge) return { deviceId: peer.id };
    return undefined;
  }

  /** Rings a call-waiting call where the callee is talking: softly (`waiting`). */
  private ringWaiting(room: Room, peers: Peer[], label: string): void {
    for (const p of peers) {
      p.conn.send({
        t: "call.ringing",
        callId: room.id,
        from: { label, ...addonFrom(room) },
        waiting: true,
      });
    }
  }

  /** A party's calls as they see them (for hold, consult, merge and transfer rules). */
  private partyCalls(peer: Peer): PartyCall[] {
    const out: PartyCall[] = [];
    for (const r of this.rooms.values()) {
      if (r.caller !== peer && r.calleePeer !== peer) continue;
      out.push({
        callId: r.id,
        phase: r.state.phase,
        ...(r.heldBy
          ? { heldBy: r.heldBy === peer.key ? ("me" as const) : ("other" as const) }
          : {}),
      });
    }
    return out;
  }

  /** May this party place a call now: nothing else going on, or a consult while holding one. */
  private canDial(peer: Peer): boolean {
    if (peer.kind === "addon") {
      // An add-on places one call at a time, within its calls at once.
      const mine = [...this.rooms.values()].filter(
        (r) => r.caller === peer || r.calleePeer === peer,
      );
      return !mine.some((r) => r.caller === peer) && mine.length < this.rulesFor(peer).lines;
    }
    if (this.conf.inRoom(peer.key)) return false;
    for (const l of this.legs.values()) if (l.peer === peer) return false;
    // Another session of the same person in a call counts too (one person, one call).
    for (const r of this.rooms.values()) {
      const theirs = r.state.caller === peer.key || r.state.callee === peer.key;
      if (theirs && r.caller !== peer && r.calleePeer !== peer) return false;
    }
    return controlCheck(this.partyCalls(peer), { type: "dial" }).ok;
  }

  /**
   * Reports a call that never got a room (denied, busy, unreachable…) to the caller, with a
   * voicemail offer when the call was allowed but can't ring through (`vm`).
   */
  private async refuse(
    peer: Peer,
    reason: EndReason,
    note?: string,
    vm?: Room["vm"],
  ): Promise<void> {
    const voicemail = vm ? await this.offer(vm, reason, this.env.now()) : undefined;
    peer.conn.send({
      t: "call.state",
      callId: newId("call"),
      state: "ended",
      reason,
      ...(note ? { note } : {}),
      ...(voicemail ? { voicemail } : {}),
    });
  }

  /** A voicemail offer for an unanswered call, if the way it ended allows one. */
  private async offer(
    vm: NonNullable<Room["vm"]>,
    reason: EndReason,
    since: number,
  ): Promise<VoicemailOffer | undefined> {
    if (!goesToVoicemail(reason)) return undefined;
    try {
      return await issueVoicemailOffer(this.env, vm.target, vm.from, since);
    } catch (e) {
      this.env.log("warn", "voicemail offer failed", { error: String(e) });
      return undefined;
    }
  }

  /**
   * The caller as a voicemail's sender: a person (from their app, or a phone they own or are
   * using) or a household phone. Nothing for guests at a Lounge phone or remote callers.
   */
  private async vmCaller(
    peer: Peer,
    label: string,
    as?: { id: string },
  ): Promise<VmCaller | undefined> {
    const { store } = this.env;
    if (peer.kind === "user") {
      const userId = as?.id ?? peer.id;
      const payer = (await store.getUser(userId))?.accountId;
      return { userId, ...(payer ? { payer } : {}), label, address: `user:${peer.id}` };
    }
    if (peer.kind !== "device") return undefined;
    // A child's voice is never recorded (COPPA): a kids' phone's unanswered call gets no
    // voicemail offer; nor does the phone of someone who left (nobody answers for it).
    if (this.strictPhone(peer)) return undefined;
    let person: string | undefined;
    if (peer.lounge) {
      const session = peer.lounge.session;
      if (!session || session.guest) return undefined;
      person = session.userId;
    } else person = as?.id ?? peer.owner;
    const payer = person
      ? (await store.getUser(person))?.accountId
      : await store.spaceOwner(this.householdId);
    return {
      ...(person ? { userId: person } : {}),
      deviceId: peer.id,
      ...(payer ? { payer } : {}),
      label,
      address: `device:${peer.id}`,
    };
  }

  /** How long a call rings a person or a phone before it goes to voicemail. */
  private async ringMs(owner: VoicemailOwner | undefined): Promise<number> {
    if (!owner) return RING_TIMEOUT_MS;
    return (await this.env.store.voicemailPrefs(owner)).ringSeconds * 1000;
  }

  private async personRingMs(userId: string): Promise<number> {
    const user = await this.env.store.getUser(userId);
    return this.ringMs(user ? { accountId: user.accountId } : undefined);
  }

  /**
   * Who pays for a call `peer` starts (as `as`), and why they can't if they're over the
   * fair-use allowance: the person calling; for a household phone, the space's first guardian.
   */
  private async allowance(
    peer: Peer,
    as?: { id: string },
  ): Promise<{ payer: string | undefined; note: string | undefined }> {
    const { store } = this.env;
    if (peer.kind === "addon") {
      // An add-on's calls count against its owner's allowance.
      const payer = peer.addon?.accountId;
      return { payer, note: await fairUseProblem(this.env, payer, "call") };
    }
    const person =
      as && as.id !== peer.id ? as.id : peer.kind === "user" ? peer.id : personOf(peer);
    let payer: string | undefined;
    if (person && !person.startsWith("guest:")) payer = (await store.getUser(person))?.accountId;
    else if (peer.kind === "device" && !person) payer = await store.spaceOwner(this.householdId);
    return { payer, note: await fairUseProblem(this.env, payer, "call") };
  }

  private async deviceDial(device: DevicePeer, index: number): Promise<void> {
    if (!this.canDial(device)) return;
    if (device.lounge) return this.loungeDial(device, index);
    const { store } = this.env;
    const allowance = await this.allowance(device);
    if (allowance.note) return this.refuse(device, "denied", allowance.note);
    const [buttons, contacts, schedule] = await Promise.all([
      store.listButtons(device.id),
      store.listContacts(device.id),
      this.scheduleFor(device),
    ]);
    const contact = resolveButton(buttons, new Map(contacts.map((c) => [c.id, c])), index);
    return this.dialContact(device, contact, schedule, allowance);
  }

  /** A phone dials an allow-list entry (a speed-dial key, or a transfer from this phone). */
  private async dialContact(
    device: DevicePeer,
    contact: Contact | undefined,
    schedule: Awaited<ReturnType<HouseholdHub["scheduleFor"]>>,
    allowance: { payer: string | undefined },
  ): Promise<void> {
    const decision = authorizeOutbound(contact, {
      quietHours: schedule,
      now: new Date(this.env.now()),
    });
    if (decision.decision === "deny" || !contact) return this.refuse(device, "denied");
    if (isRoomContactId(contact.id)) return this.joinFromPhone(device, contact.id);
    if (isLineContactId(contact.id)) {
      const entry = await this.env.store.lines.contact(device.id, contact.id);
      return entry ? this.addressDial(device, entry.address) : this.refuse(device, "denied");
    }
    if (isRemoteContactId(contact.id)) return this.remoteContactDial(device, contact.id);
    const from = await this.vmCaller(device, device.label);
    const vm = from && {
      target: { kind: "user" as const, userId: contact.id, name: contact.label },
      from: {
        ...from,
        check: { deviceId: device.id, userId: contact.id, field: "deviceCanCall" as const },
      },
    };
    const targets = this.reachable(contact.id, device);
    const plans = await this.branchesFor(contact.id);
    if (!targets.length && !plans.length) return this.refuse(device, "unreachable", undefined, vm);
    const waiting = this.busy(userKey(contact.id))
      ? await this.waitingRing(userKey(contact.id))
      : [];
    if (this.busy(userKey(contact.id)) && !waiting.length) {
      return this.refuse(device, "busy", undefined, vm);
    }

    const room = this.openRoom(
      device,
      userKey(contact.id),
      undefined,
      await this.personRingMs(contact.id),
    );
    room.payer = allowance.payer;
    if (vm) room.vm = vm;
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    if (waiting.length) this.ringWaiting(room, waiting, device.label);
    else this.ringAll(room, targets, plans, device.label);
  }

  /**
   * `user` calls a household phone. From a Lounge phone, `user` is the phone and `as` the person
   * using it: the call is allowed exactly when that person could make it from their app.
   */
  private async appDial(
    user: Peer,
    deviceId: string,
    as: { id: string; label: string } = user,
  ): Promise<void> {
    const { store } = this.env;
    const device = await store.getDevice(deviceId);
    if (!device || device.householdId !== this.householdId || deviceId === user.id) {
      user.conn.send({ t: "error", code: "not_found", message: "no such device" });
      return;
    }
    // Nobody answers for the phone of someone who left: it never rings.
    if (deviceMode(device) === "left") return this.refuse(user, "denied", LEFT_PHONE_NOTE);
    const [contact, schedule] = await Promise.all([
      store.getContact(deviceId, as.id),
      device.ownerUserId
        ? store.getSchedule(this.householdId).then((q) => ({ ...q, rules: [] }))
        : store.getSchedule(this.householdId),
    ]);
    const decision = authorizeInbound(contact, {
      quietHours: schedule,
      now: new Date(this.env.now()),
    });
    if (decision.decision === "deny" || !contact) return this.refuse(user, "denied");
    // Voicemail for a household phone: its guardians' inbox (never a Lounge phone's).
    const from =
      device.kind === "lounge" ? undefined : await this.vmCaller(user, contact.label, as);
    const vm = from && {
      target: device.ownerUserId
        ? { kind: "user" as const, userId: device.ownerUserId, name: device.name }
        : { kind: "device" as const, deviceId, name: device.name },
      from: {
        ...from,
        check: { deviceId, userId: as.id, field: "canCallDevice" as const },
      },
    };
    if (decision.decision === "voicemail") return this.refuse(user, "voicemail", undefined, vm);
    const peer = this.devices.get(deviceId);
    if (!peer) return this.refuse(user, "unreachable", undefined, vm);
    if (!this.canDial(user)) return this.refuse(user, "busy", CALLER_BUSY_NOTE);
    // In a call: call waiting (if it may ring softly there), else busy. Handset up: busy.
    const waiting = this.busy(peer.key) ? (await this.waitingRing(peer.key)).length > 0 : false;
    if ((this.busy(peer.key) && !waiting) || (peer.hook === "up" && !waiting)) {
      return this.refuse(user, "busy", undefined, vm);
    }
    const allowance = await this.allowance(user, as);
    if (allowance.note) return this.refuse(user, "denied", allowance.note);

    const room = this.openRoom(
      user,
      peer.key,
      undefined,
      await this.ringMs(
        device.ownerUserId
          ? { accountId: (await store.getUser(device.ownerUserId))?.accountId ?? "" }
          : { deviceId },
      ),
    );
    room.payer = allowance.payer;
    if (vm) room.vm = vm;
    room.calleePeer = peer;
    this.roomsDirty = true;
    user.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    peer.conn.send({
      t: "call.ringing",
      callId: room.id,
      from: { label: contact.label },
      ...(waiting ? { waiting: true as const } : {}),
    });
  }

  /**
   * Grown-up, app-to-app call between two members of this server. Refused unless the callee
   * has an open session and is taking calls; never rings a busy person.
   */
  private async userDial(
    caller: Peer,
    userId: string,
    as: { id: string; label: string } = caller,
    opts: { addonShare?: { id: string; label: string; grantId?: string } } = {},
  ): Promise<void> {
    if (userId === as.id) {
      caller.conn.send({ t: "error", code: "bad_message", message: "you can't call yourself" });
      return;
    }
    const callee = await this.env.store.getUser(userId);
    if (!callee || callee.householdId !== this.householdId) {
      caller.conn.send({ t: "error", code: "not_found", message: "no such person" });
      return;
    }
    const from = await this.vmCaller(caller, as.label, as);
    const vm = from && {
      target: { kind: "user" as const, userId, name: callee.name },
      from,
    };
    if (!this.canDial(caller)) return this.refuse(caller, "busy", CALLER_BUSY_NOTE);
    const targets = this.reachable(userId);
    const plans = await this.branchesFor(userId);
    if (!targets.length && !plans.length) return this.refuse(caller, "unreachable", undefined, vm);
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    if (!available) return this.refuse(caller, "unavailable", undefined, vm);
    const waiting = this.busy(userKey(userId)) ? await this.waitingRing(userKey(userId)) : [];
    if (this.busy(userKey(userId)) && !waiting.length) {
      return this.refuse(caller, "busy", undefined, vm);
    }
    const allowance = await this.allowance(caller, as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);

    const room = this.openRoom(caller, userKey(userId), undefined, await this.personRingMs(userId));
    room.payer = allowance.payer;
    if (vm) room.vm = vm;
    if (opts.addonShare) room.addonShare = opts.addonShare;
    caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    if (waiting.length) this.ringWaiting(room, waiting, as.label);
    else this.ringAll(room, targets, plans, as.label);
  }

  /**
   * Where else a person can be rung besides this household: their other spaces on this server
   * (each rings that space's app sessions, own phones and Lounge phone) and any Lounge phone on
   * another server where they're a guest right now.
   */
  private async branchesFor(userId: string): Promise<BranchPlan[]> {
    const { store } = this.env;
    const user = await store.getUser(userId);
    if (!user || !this.env.calls) return [];
    const plans: BranchPlan[] = [];
    for (const m of await store.listMemberships(user.accountId)) {
      if (m.household.id !== this.householdId) {
        plans.push({ kind: "space", householdId: m.household.id, userId: m.user.id });
      }
    }
    const away = await store.activeLoungeAway(user.accountId);
    if (away.length) {
      const account = (await store.getAccount(user.accountId)) as Account;
      for (const a of away) {
        plans.push({ kind: "away", host: a.host, deviceId: a.deviceId, guest: partyOf(account) });
      }
    }
    return plans;
  }

  /** Rings a person's targets here, and starts their branches elsewhere. */
  private ringAll(room: Room, targets: Peer[], plans: BranchPlan[], label: string): void {
    // A public line's call shows who is calling, as their server vouches for them; so does an
    // add-on's (labelled as one).
    const line = room.line;
    const addon = room.caller.addon;
    for (const t of targets) {
      t.conn.send({
        t: "call.ringing",
        callId: room.id,
        from: { label, ...(line ? { address: line.address } : addonFrom(room)) },
        ...(line ? { line: line.info } : {}),
      });
    }
    const calls = this.env.calls;
    if (!calls) return;
    for (const plan of plans) {
      // An add-on's call rings this server only (a guest's Lounge phone elsewhere couldn't
      // label it).
      if (addon && plan.kind === "away") continue;
      const leg = newId("call");
      const branch = this.remotePeer({
        host: plan.kind === "space" ? LOCAL_HOST : plan.host,
        key: `branch:${leg}`,
        label,
        peerHousehold: plan.kind === "space" ? plan.householdId : undefined,
        leg,
      });
      room.branches = [...(room.branches ?? []), branch];
      this.roomsDirty = true;
      // Over the network or another hub's queue: never awaited inside this hub's queue.
      const ring: Promise<RingResult> =
        plan.kind === "space"
          ? calls.ringLocal(plan.householdId, {
              callId: leg,
              host: LOCAL_HOST,
              key: room.state.caller,
              label,
              target: { kind: "person", userId: plan.userId },
              peerHousehold: this.householdId,
              noBranches: true,
              ...(addon ? { addon: addonOf(room) } : {}),
            })
          : calls.register(plan.host, leg, this.householdId).then(() =>
              calls.place(
                plan.host,
                {
                  callId: leg,
                  from: plan.guest,
                  to: { kind: "guest", deviceId: plan.deviceId },
                  ringLabel: label.slice(0, 24),
                },
                this.householdId,
              ),
            );
      void ring.then(
        (r) =>
          r.state === "ended" ? this.run(() => this.dropBranch(room, branch, r.reason)) : undefined,
        () => this.run(() => this.dropBranch(room, branch, "unreachable")),
      );
    }
  }

  /** A branch stopped ringing. A decline ends the call; otherwise it ends when nothing rings. */
  private async dropBranch(room: Room, branch: Peer, reason: EndReason): Promise<void> {
    if (this.rooms.get(room.id) !== room || room.calleePeer || !room.branches?.includes(branch)) {
      return;
    }
    room.branches = room.branches.filter((b) => b !== branch);
    this.roomsDirty = true;
    if (reason === "declined") return this.apply(room, { type: "end", reason });
    if (this.ringTargets(room).length === 0) {
      await this.apply(room, { type: "end", reason: reason === "hangup" ? "unreachable" : reason });
    }
  }

  /** Where a person can be rung right now: open app sessions + own phones that are hung up. */
  private reachable(userId: string, except?: Peer): Peer[] {
    const phones = [...this.devices.values()].filter(
      (d) => personOf(d) === userId && d !== except && d.hook === "down" && !this.busy(d.key),
    );
    return [...(this.apps.get(userId) ?? []), ...phones];
  }

  /** Grown-ups' own phones don't follow the household's (kids') quiet hours. */
  private async scheduleFor(peer: DevicePeer | undefined) {
    const schedule = await this.env.store.getSchedule(this.householdId);
    return peer?.owner ? { ...schedule, rules: [] } : schedule;
  }

  /** Presence of one member, to every other connected member. */
  private broadcastMember(userId: string, available: boolean): void {
    const msg = this.memberMessage(userId, available);
    // Rate-limited for connections: it's sent later, when this hub wakes (no timer of its own).
    void this.env
      .onPresence?.(this.householdId, userId, msg.online, available)
      ?.then((due) => (due === undefined ? undefined : this.run(() => this.scheduleWake())));
    for (const [id, set] of this.apps) {
      if (id === userId) continue;
      for (const app of set) app.conn.send(msg);
    }
  }

  private memberMessage(
    userId: string,
    available: boolean,
  ): Extract<ServerToApp, { t: "member.status" }> {
    const lounge = this.loungeOf(userId);
    return {
      t: "member.status",
      userId,
      online: this.userOnline(userId),
      available,
      ...(lounge ? { lounge } : {}),
    };
  }

  /** The Lounge phone a person is using, if any. */
  private loungeOf(userId: string) {
    for (const d of this.devices.values()) {
      const s = d.lounge?.session;
      if (s?.userId === userId) return { deviceId: d.id, label: d.label, openToChat: s.openToChat };
    }
    return undefined;
  }

  private openRoom(
    caller: Peer,
    calleeKey: string,
    id = newId("call"),
    ringMs = RING_TIMEOUT_MS,
  ): Room {
    const room: Room = {
      id,
      state: newRoom(caller.key, calleeKey),
      caller,
      startedAt: this.env.now(),
    };
    this.rooms.set(room.id, room);
    this.roomsDirty = true;
    room.cancelTimer = this.env.setTimer(
      () => void this.run(() => this.apply(room, { type: "timeout" })),
      ringMs,
    );
    return room;
  }

  // --- in-call ----------------------------------------------------------------

  private partyOf(room: Room, peer: Peer): "caller" | "callee" | undefined {
    if (room.caller === peer) return "caller";
    if (room.calleePeer === peer) return "callee";
    if (!room.calleePeer && this.answersFor(peer, room.state.callee)) return "callee";
    if (!room.calleePeer && room.group && this.inGroup(peer, room.group)) return "callee";
    return undefined;
  }

  /** A member of a house-line group (their app, or a phone that stands for them). */
  private inGroup(peer: Peer, group: string[]): boolean {
    const person = peer.kind === "user" ? peer.id : peer.kind === "device" ? personOf(peer) : "";
    return !!person && group.includes(person);
  }

  /** A person's calls ring their open app sessions and their own phones. */
  private answersFor(peer: Peer, calleeKey: string): boolean {
    if (peer.key === calleeKey) return true;
    if (peer.kind !== "device") return false;
    const person = personOf(peer);
    return !!person && userKey(person) === calleeKey;
  }

  /** Everything currently ringing for an unanswered call. */
  private ringTargets(room: Room): Peer[] {
    if (room.calleePeer) return [];
    const branches = room.branches ?? [];
    const key = room.state.callee;
    if (room.group) return room.group.flatMap((u) => this.reachable(u, room.caller));
    if (!key.startsWith("usr:")) return branches;
    const userId = idOf(key);
    const phones = [...this.devices.values()].filter((d) => personOf(d) === userId);
    return [...(this.apps.get(userId) ?? []), ...phones, ...branches];
  }

  /** Online = an open companion session, a connected personal phone, or a Lounge phone. */
  private userOnline(userId: string): boolean {
    return this.apps.has(userId) || [...this.devices.values()].some((d) => personOf(d) === userId);
  }

  private async announceMember(userId: string): Promise<void> {
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    this.broadcastMember(userId, available);
  }

  private async callMessage(
    peer: Peer,
    msg: Extract<AppToServer, { t: "call.answer" | "call.hangup" | "rtc.sdp" | "rtc.ice" }>,
  ): Promise<void> {
    if (msg.t === "call.answer" || msg.t === "call.hangup") {
      const ringing = this.callbackRings.get(msg.callId);
      if (ringing) return this.callbackReply(peer, msg.callId, ringing, msg.t === "call.answer");
    }
    const room = this.rooms.get(msg.callId);
    const party = room && this.partyOf(room, peer);
    if (!room || !party) {
      // Late messages for a finished call are normal; tell the sender it is over. Not for a
      // hang-up: the sender is done with it, and its ended went out already (a second one could
      // end the sender's next call).
      if (msg.t === "call.answer" || msg.t === "rtc.sdp") {
        peer.conn.send({ t: "call.state", callId: msg.callId, state: "ended", reason: "hangup" });
      }
      return;
    }

    if (msg.t === "call.answer") {
      if (party !== "callee" || room.state.phase !== "ringing") return;
      // Call waiting: the call they're in goes on hold first (or the answer is refused). An
      // add-on takes calls side by side instead (up to its calls at once).
      const current = [...this.rooms.values()].find(
        (r) =>
          peer.kind !== "addon" &&
          r !== room &&
          (r.caller === peer || r.calleePeer === peer) &&
          (r.state.phase === "active" || r.state.phase === "connecting"),
      );
      if (current && current.heldBy !== peer.key) {
        const check = controlCheck(
          this.partyCalls(peer).filter((c) => c.callId !== room.id),
          { type: "hold", callId: current.id, hold: true },
        );
        if (!check.ok) return this.refuseControl(peer, check.error);
        await this.hold(peer, current.id, true, room.id);
      }
      // Everything else that was ringing for the callee (other sessions, own phones) stops.
      for (const other of this.ringTargets(room)) {
        if (other !== peer) {
          other.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
        }
      }
      room.calleePeer = peer;
      this.roomsDirty = true;
      await this.apply(room, { type: "answer", by: room.state.callee });
      return;
    }
    if (msg.t === "call.hangup") {
      // A ring-group member declining stops only their ringing.
      if (party === "callee" && room.hunt && !room.calleePeer && room.state.phase === "ringing") {
        return this.groupDecline(room, peer);
      }
      // The audio connection dropped and couldn't be restored: everyone hears why it ended.
      if (msg.lost && (room.state.phase === "connecting" || room.state.phase === "active")) {
        room.endNote = CONNECTION_LOST_NOTE;
        return this.apply(room, { type: "fail" });
      }
      const by = party === "caller" ? room.state.caller : room.state.callee;
      await this.apply(room, { type: "hangup", by });
      return;
    }

    // rtc.*: relay only once both ends are known and media negotiation has started.
    if (room.state.phase !== "connecting" && room.state.phase !== "active") return;
    // partyOf already excludes the callee's other sessions once one has answered.
    const other = party === "caller" ? room.calleePeer : room.caller;
    if (!other) return;
    other.conn.send(msg);
    if (msg.t === "rtc.sdp" && msg.type === "answer") {
      await this.apply(room, { type: "connected" });
    }
  }

  private async apply(room: Room, event: RoomEvent): Promise<void> {
    const r = roomStep(room.state, event);
    if (!r.ok) {
      this.env.log("warn", "rejected room event", { callId: room.id, event, error: r.error });
      return;
    }
    if (!r.changed) return;
    room.state = r.state;
    this.roomsDirty = true;
    const both = [room.caller, room.calleePeer].filter((p): p is Peer => !!p);

    switch (r.state.phase) {
      case "connecting": {
        room.answered = true;
        if (room.line) {
          room.line.waiting = false;
          room.cancelWait?.();
        }
        room.cancelTimer?.();
        room.cancelTimer = this.env.setTimer(
          () => void this.run(() => this.apply(room, { type: "timeout" })),
          CONNECT_TIMEOUT_MS,
        );
        // A call with an add-on: TURN credentials last no longer than its longest call, and are
        // revoked when it ends where the host can.
        const addonCall = this.isAddonRoom(room);
        const iceServers = await this.env.iceServers(
          addonCall ? { ttlSeconds: limitsOf(this.env).addonCallMinutes * 60 + 120 } : undefined,
        );
        if (addonCall && this.env.revokeIce) {
          const users = iceServers.flatMap((x) => (x.username ? [x.username] : []));
          if (users.length) room.turnUsers = [...new Set(users)];
        }
        for (const p of both) {
          p.conn.send({ t: "rtc.config", callId: room.id, iceServers });
          p.conn.send({ t: "call.state", callId: room.id, state: "connecting" });
        }
        return;
      }
      case "active":
        room.cancelTimer?.();
        room.cancelTimer = undefined;
        room.activeAt = this.env.now();
        for (const p of both) p.conn.send({ t: "call.state", callId: room.id, state: "active" });
        await this.announceRecording(room);
        // Its longest length is watched by the hub's alarm.
        if (this.isAddonRoom(room)) await this.scheduleWake();
        return;
      case "ended": {
        room.cancelTimer?.();
        room.cancelWait?.();
        this.rooms.delete(room.id);
        if (room.turnUsers?.length && this.env.revokeIce) {
          const users = room.turnUsers;
          this.env.defer(
            this.env
              .revokeIce(users)
              .catch((e) =>
                this.env.log("warn", "TURN credentials not revoked", { error: String(e) }),
              ),
          );
        }
        for (const [k, v] of this.handoffs) if (v === room.id) this.handoffs.delete(k);
        await this.logCall(room, r.state.reason ?? "hangup").catch((e) =>
          this.env.log("warn", "call log failed", { error: String(e) }),
        );
        this.maybeSweep();
        await this.recordMissed(room, r.state.reason ?? "hangup").catch((e) =>
          this.env.log("warn", "missed call not recorded", { error: String(e) }),
        );
        if (room.payer && room.activeAt !== undefined) {
          // Metered at the end, rounded up to whole minutes; enforced only when calls start.
          const minutes = Math.ceil((this.env.now() - room.activeAt) / 60_000);
          await this.env.store.addUsage(room.payer, this.env.now(), { callMinutes: minutes });
        }
        const reason = r.state.reason ?? "hangup";
        const ringing = this.ringTargets(room);
        // Unanswered: the caller may leave a message (the offer goes to the caller only).
        const voicemail =
          room.vm && !room.answered
            ? await this.offer(room.vm, reason, room.startedAt ?? this.env.now())
            : undefined;
        for (const p of [...both, ...ringing]) {
          p.conn.send({
            t: "call.state",
            callId: room.id,
            state: "ended",
            reason,
            ...(room.endNote ? { note: room.endNote } : {}),
            ...(voicemail && p === room.caller ? { voicemail } : {}),
            ...(room.callbackUntil !== undefined && p === room.caller
              ? { callback: { until: room.callbackUntil } }
              : {}),
          });
        }
        for (const p of both) {
          const d = this.devices.get(p.id);
          if (d === p && d.lounge) await this.touchIdle(d);
        }
        if (room.line) {
          const outcome = room.answered
            ? "answered"
            : voicemail
              ? "voicemail"
              : room.callbackUntil !== undefined
                ? "call back"
                : reason === "hangup"
                  ? "hung up"
                  : "missed";
          await logLineCaller(this.env, {
            groupId: room.line.groupId,
            householdId: this.householdId,
            address: room.line.address,
            name: room.line.name,
            outcome,
          });
        }
        // Someone may be free now (or a caller left the line): the queue moves.
        this.kickLines();
        return;
      }
      default:
        return;
    }
  }

  // --- greetings recorded on the phone ------------------------------------------------

  /**
   * Whose greeting a phone records from MENU → Voicemail: its owner's (a person's own phone).
   * A kids' phone never records the child (COPPA); its guardians record its greeting in the app.
   * Lounge phones have none.
   */
  private async phoneGreeting(
    device: DevicePeer,
  ): Promise<{ owner: VoicemailOwner; canRecord: boolean } | undefined> {
    if (device.lounge) return undefined;
    if (device.owner) {
      const user = await this.env.store.getUser(device.owner);
      return user ? { owner: { accountId: user.accountId }, canRecord: true } : undefined;
    }
    return { owner: { deviceId: device.id }, canRecord: false };
  }

  private async greetingFromPhone(
    device: DevicePeer,
    msg: Extract<DeviceToServer, { t: "greeting.begin" | "greeting.reset" }>,
  ): Promise<void> {
    const g = await this.phoneGreeting(device);
    if (!g?.canRecord) {
      const kind = g ? (await greetingOf(this.env, g.owner, false)).kind : "default";
      device.conn.send({ t: "greeting.done", result: "not_allowed", kind });
      return;
    }
    if (msg.t === "greeting.reset") {
      await resetGreeting(this.env, g.owner);
      device.conn.send({ t: "greeting.done", result: "reset", kind: "default" });
      await this.sendConfig(device, true);
      return;
    }
    const { ticket, maxMs } = await issueGreetingTicket(this.env, {
      owner: g.owner,
      kind: msg.kind,
      deviceId: device.id,
      householdId: this.householdId,
    });
    device.conn.send({ t: "greeting.ticket", kind: msg.kind, ticket, maxMs });
  }

  /**
   * A person's own phone plays their unheard messages (from every space they're in), oldest
   * first; each playable one (WAV) gets a single-use ticket for `GET /api/vm/play`. Kids' and
   * Lounge phones get none: a grown-up listens in the app.
   */
  private async voicemailFetch(device: DevicePeer): Promise<void> {
    const { store } = this.env;
    const owner = device.owner && !device.lounge ? await store.getUser(device.owner) : undefined;
    if (!owner) {
      device.conn.send({ t: "voicemail.items", items: [] });
      return;
    }
    const unheard = (await store.listPersonalVoicemails(owner.accountId))
      .filter((v) => v.heardAt === null)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, 8);
    const now = this.env.now();
    const items = [];
    for (const v of unheard) {
      const playable = /^audio\/(wav|x-wav)$/.test(v.mime);
      const ticket = playable
        ? await store.createVoicemailTicket("play", { voicemailId: v.id, deviceId: device.id }, now)
        : undefined;
      items.push({
        id: v.id,
        from: v.fromLabel.slice(0, 24),
        at: v.createdAt,
        durationMs: v.durationMs,
        ...(ticket ? { ticket } : {}),
      });
    }
    device.conn.send({ t: "voicemail.items", items });
  }

  /**
   * Labs check-in: nobody pressed I'm OK in time. Every guardian of the space (but the person whose
   * phone it is) gets an alert in their voicemail inbox: a short chime with the words as its
   * transcript; their apps hear about it now and their own phones show it as missed. Once a day.
   */
  private async checkinMissed(
    device: { id: string; label: string; owner?: string },
    by: string,
  ): Promise<void> {
    const { store } = this.env;
    const now = this.env.now();
    const last = this.checkinAlerts.get(device.id) ?? 0;
    if (now - last < 12 * 3_600_000) return;
    this.checkinAlerts.set(device.id, now);
    const name = device.label;
    const text = `${name} didn't check in by ${by}.`;
    const audio = checkinChime();
    for (const u of await store.listUsers(this.householdId)) {
      if (u.role !== "guardian" || u.id === device.owner) continue;
      const blobKey = `voicemail/${this.householdId}/${newId("vmb")}`;
      await this.env.blobs.put(blobKey, audio.buffer as ArrayBuffer, "audio/wav");
      const vm = await store.createVoicemail({
        householdId: this.householdId,
        deviceId: null,
        toUser: u.id,
        groupId: null,
        fromUser: null,
        fromLabel: name.slice(0, 24),
        fromAddress: `device:${device.id}`,
        createdAt: now,
        durationMs: 800,
        mime: "audio/wav",
        blobKey,
        transcriptStatus: "done",
      });
      await store.setTranscript(vm.id, "done", text);
      for (const app of this.apps.get(u.id) ?? []) {
        app.conn.send({ t: "voicemail.inbox", id: vm.id, from: name.slice(0, 24) });
      }
      for (const m of await store.listMemberships(u.accountId)) {
        for (const d of await store.listDevices(m.household.id)) {
          if (d.ownerUserId !== m.user.id) continue;
          if (m.household.id === this.householdId) {
            const peer = this.devices.get(d.id);
            if (peer) await this.sendConfig(peer, true);
          } else await this.env.calls?.refreshDevice(m.household.id, d.id);
        }
      }
    }
    this.env.log("info", "check-in missed", { device: device.id, by });
  }

  /** The phone played a message to the end: heard, everywhere the owner sees it. */
  private async voicemailHeard(device: DevicePeer, id: string): Promise<void> {
    const { store } = this.env;
    const owner = device.owner && !device.lounge ? await store.getUser(device.owner) : undefined;
    const vm = owner ? await store.getVoicemail(id) : undefined;
    const to = vm?.toUser ? await store.getUser(vm.toUser) : undefined;
    if (!owner || !vm || to?.accountId !== owner.accountId) return;
    await store.markVoicemailHeard(vm.id, this.env.now(), to.id);
    await this.sendConfig(device, true);
    // The owner's other phones, here and in their other spaces.
    await this.refreshAccountPhones(owner.accountId, device.id);
  }

  /**
   * What a phone shows as missed, newest first: unheard voicemail by sender, and on a person's own
   * phone the public lines whose call back they didn't take (`callback`).
   */
  private async missedFor(peer: DevicePeer): Promise<MissedItem[]> {
    const { store } = this.env;
    type Entry = MissedItem & { at: number };
    const voicemail: Entry[] = (await store.unheardSenders(peer.id, 8, peer.owner)).map((v) => ({
      from: v.from,
      at: v.at,
      kind: "voicemail" as const,
    }));
    const owner = peer.owner ? await store.getUser(peer.owner) : undefined;
    const lines: Entry[] = owner
      ? (await store.lines.missedCallbacks(owner.accountId, 8)).map((m) => ({
          from: m.lineName,
          at: m.at,
          callback: true as const,
          id: m.id,
        }))
      : [];
    // Missed calls (rang, nobody answered, no message): only to phones that show them truthfully.
    const calls: Entry[] = peer.features?.includes("missed-calls")
      ? (
          await store.missed.list(owner ? { accountId: owner.accountId } : { deviceId: peer.id })
        ).map((m) => ({
          from: m.fromLabel,
          at: m.at,
          kind: "call" as const,
          count: m.count,
          id: m.id,
        }))
      : [];
    return [...voicemail, ...lines, ...calls]
      .filter((m) => m.from.trim())
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
      .map((m) => ({ ...m, from: m.from.slice(0, 24) }));
  }

  /**
   * A call that rang a person or a household phone here and nobody answered (no answer in time,
   * or the caller gave up): a missed call. It moves to voicemail if the caller then leaves a
   * message (`depositVoicemail`). Not for a branch of a call another household here owns (that
   * one records it), public lines, ring groups or house-line groups, nor Lounge phones.
   */
  private async recordMissed(room: Room, reason: EndReason): Promise<void> {
    if (room.answered || room.branchLeg || room.line || room.hunt || room.group) return;
    if (reason !== "timeout" && reason !== "hangup") return;
    const owner = await this.missedOwner(room.state.callee);
    if (!owner) return;
    const from = await this.describe(room.caller, room.state.caller);
    await this.env.store.missed.add({
      householdId: this.householdId,
      owner,
      callId: room.id,
      fromLabel: from.label || room.caller.label,
      fromPeer: from.peer,
      at: room.startedAt ?? this.env.now(),
    });
    await this.missedChanged(owner);
  }

  /** Whose missed call a call to `calleeKey` is: a person's (all their phones and apps) or a
   * household phone's own; a Lounge phone keeps none. */
  private async missedOwner(calleeKey: string): Promise<MissedOwner | undefined> {
    const { store } = this.env;
    if (calleeKey.startsWith("usr:")) {
      const user = await store.getUser(idOf(calleeKey));
      return user ? { accountId: user.accountId } : undefined;
    }
    if (!calleeKey.startsWith("dev:")) return undefined;
    const device = await store.getDevice(idOf(calleeKey));
    if (!device || device.kind === "lounge") return undefined;
    if (!device.ownerUserId) return { deviceId: device.id };
    const owner = await store.getUser(device.ownerUserId);
    return owner ? { accountId: owner.accountId } : undefined;
  }

  /** Missed calls changed: the phones that show them get fresh config, the apps are told. */
  private async missedChanged(owner: MissedOwner): Promise<void> {
    if ("deviceId" in owner) {
      const peer = this.devices.get(owner.deviceId);
      if (peer) await this.sendConfig(peer, true);
      return;
    }
    await this.refreshAccountPhones(owner.accountId);
    const calls = this.env.calls;
    if (calls) {
      // The apps in every space of the account; not awaited: this hub's own turn comes after.
      void calls.notifyAccount(owner.accountId, { t: "missed.changed" }).catch(() => {});
      return;
    }
    for (const m of await this.env.store.listMemberships(owner.accountId)) {
      if (m.household.id !== this.householdId) continue;
      for (const app of this.apps.get(m.user.id) ?? []) app.conn.send({ t: "missed.changed" });
    }
  }

  /** Fresh config for an account's own phones, here and in its other spaces (`except` one). */
  private async refreshAccountPhones(accountId: string, except?: string): Promise<void> {
    const { store } = this.env;
    for (const m of await store.listMemberships(accountId)) {
      for (const d of await store.listDevices(m.household.id)) {
        if (d.ownerUserId !== m.user.id || d.id === except) continue;
        if (m.household.id === this.householdId) {
          const peer = this.devices.get(d.id);
          if (peer) await this.sendConfig(peer, true);
        } else {
          await this.env.calls?.refreshDevice(m.household.id, d.id);
        }
      }
    }
  }

  /**
   * MENU → Missed → Clear (and, on older phones, MENU → Voicemail → Clear): missed calls are
   * marked seen and missed call backs forgotten, everywhere they show: a person's own phone
   * clears its owner's (all their phones and apps), a household phone its own.
   */
  private async missedClear(device: DevicePeer): Promise<void> {
    if (device.lounge) return;
    const { store } = this.env;
    const owner = device.owner ? await store.getUser(device.owner) : undefined;
    if (device.owner && !owner) return;
    if (owner) await store.lines.clearMissedCallbacks(owner.accountId);
    const whose: MissedOwner = owner ? { accountId: owner.accountId } : { deviceId: device.id };
    await store.missed.clear(whose, this.env.now());
    await this.missedChanged(whose);
  }

  /**
   * MENU → Missed → 1: call a missed caller back. Like dialing: a household phone may call only
   * someone on its allow-list (with its quiet hours); a person's own phone calls as its owner
   * would from their app. A caller who can't be reached from this phone's space is
   * `unreachable`; anything not this phone's own is `denied`.
   */
  private async callBackMissed(device: DevicePeer, id: string): Promise<void> {
    if (!this.canDial(device)) return;
    if (device.lounge) return this.refuse(device, "denied");
    const { store } = this.env;
    const owner = device.owner ? await store.getUser(device.owner) : undefined;
    if (id.startsWith("mcb")) {
      // A public line's call back nobody took: call the line again.
      const cb = owner ? await store.lines.missedCallback(id) : undefined;
      if (!owner || cb?.accountId !== owner.accountId) return this.refuse(device, "denied");
      return this.addressDial(device, cb.lineAddress);
    }
    const row = await store.missed.get(id);
    const mine = row && (owner ? row.accountId === owner.accountId : row.deviceId === device.id);
    if (!row || !mine) return this.refuse(device, "denied");
    const peer = row.fromPeer;
    const allowance = await this.allowance(device);
    if (allowance.note) return this.refuse(device, "denied", allowance.note);
    if (!owner) {
      // A household phone: only someone on its allow-list it may call.
      const contact = peer.startsWith("user:")
        ? (await store.listContacts(device.id)).find((c) => c.id === peer.slice("user:".length))
        : (await store.listRemoteContacts(device.id)).find(
            (r) => addressOf(this.env, r.connection) === peer,
          );
      return this.dialContact(device, contact, await this.scheduleFor(device), allowance);
    }
    // A person's own phone: as its owner would from their app.
    const as = { id: owner.id, label: owner.name };
    if (peer.startsWith("user:")) {
      const user = await store.getUser(peer.slice("user:".length));
      if (user?.householdId === this.householdId) return this.userDial(device, user.id, as);
    } else if (peer.startsWith("device:")) {
      const d = await store.getDevice(peer.slice("device:".length));
      if (d?.householdId === this.householdId) return this.appDial(device, d.id, as);
    } else if (peer.includes("@")) {
      const conn = (await store.connections.list(owner.accountId)).find(
        (c) => c.state === "active" && addressOf(this.env, c) === peer.toLowerCase(),
      );
      if (conn) return this.connectionDial(device, conn.id, as);
    }
    return this.refuse(device, "unreachable");
  }

  // --- config & status ----------------------------------------------------------

  private async sendConfig(peer: DevicePeer, force: boolean): Promise<void> {
    const { store } = this.env;
    const owner = await this.ownerLine(peer);
    if (peer.lounge) {
      // Only the person using it: their speed-dial. Nobody there: nothing, unless the space
      // gave idle phones house-line keys or "who's here".
      if (!force) return;
      const session = peer.lounge.session;
      if (!session) {
        peer.conn.send({
          t: "config",
          ...(await this.idleLoungeConfig(peer)),
          quiet: false,
          ...(owner ? { owner } : {}),
          server: serverInfo(this.env),
        });
        return;
      }
      const dir = await this.sessionDirectory(session);
      const extensions = !session.guest && (await this.hasExtensions());
      peer.conn.send(
        fitConfig({
          t: "config",
          ...this.keyPagesFor(
            peer,
            [...dir].map(([index, e]) => ({ index, label: e.label })),
          ),
          quiet: false,
          ...(owner ? { owner } : {}),
          ...(extensions ? { extensions: true } : {}),
          server: serverInfo(this.env),
        }),
      );
      return;
    }
    const [buttons, contacts, schedule, missed, greeting, extensions, home] = await Promise.all([
      store.listButtons(peer.id),
      store.listContacts(peer.id),
      this.scheduleFor(peer),
      this.missedFor(peer),
      this.phoneGreeting(peer),
      peer.owner ? this.hasExtensions() : false,
      this.homeConfig(peer),
    ]);
    const now = new Date(this.env.now());
    const quiet = isQuietAt(schedule, now);
    if (!force && quiet === peer.lastQuiet) return;
    if (quiet !== peer.lastQuiet) {
      peer.lastQuiet = quiet;
      this.remember(peer);
    }
    const byId = new Map(contacts.map((c) => [c.id, c]));
    // Keys that call an add-on say so (the phone shows it as one while calling).
    const addonKeys = new Set(
      (await store.lines.onPhone(peer.id))
        .filter((l) => parseAddonAddress(l.address))
        .map((l) => l.id),
    );
    const mapped = [...buttons]
      .map(([index, userId]) => ({ index, userId, contact: byId.get(userId) }))
      .filter((b) => b.contact?.deviceCanCall)
      .map((b) => ({
        index: b.index,
        label: b.contact?.label ?? "",
        ...(addonKeys.has(b.userId) ? { addon: true as const } : {}),
      }));
    const end = quiet ? nextQuietChange(schedule, now) : undefined;
    let quietUntil: string | undefined;
    if (end) {
      const { minutes } = localClock(end, schedule.timeZone);
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      quietUntil = `${hh}:${String(minutes % 60).padStart(2, "0")}`;
    }
    const keys = this.keyPagesFor(peer, mapped);
    const config: Extract<ServerToDevice, { t: "config" }> = {
      t: "config",
      ...keys,
      ...(owner ? { owner } : {}),
      quiet,
      ...(quietUntil ? { quietUntil } : {}),
      utcOffsetMin: utcOffsetMinutes(now, schedule.timeZone),
      now: now.getTime(),
      ...(missed.length ? { missed } : {}),
      ...(greeting
        ? {
            greeting: {
              kind: (await greetingOf(this.env, greeting.owner, false)).kind,
              canRecord: greeting.canRecord,
            },
          }
        : {}),
      ...(extensions ? { extensions: true } : {}),
      ...home,
      server: serverInfo(this.env),
    };
    peer.conn.send(fitConfig(config));
  }

  /**
   * A phone's keys as `config` carries them: page 1 in `buttons`; later pages in `pages`, only
   * to phones that show them (`hello.features` `key-pages`), as many as this server allows.
   */
  private keyPagesFor<T extends { index: number }>(peer: DevicePeer, keys: T[]) {
    return splitKeyPages(keys, !!peer.features?.includes("key-pages"), limitsOf(this.env).keyPages);
  }

  /** A phone's home features in its config: check-in, chime, intercom (each when it's on). */
  private async homeConfig(peer: DevicePeer) {
    const { store } = this.env;
    const h = await store.home.get(peer.id);
    const out: Partial<Extract<ServerToDevice, { t: "config" }>> = {};
    if (h.checkinBy) {
      const space = await store.getHousehold(this.householdId);
      const today = localDay(new Date(this.env.now()), space?.timeZone ?? "UTC");
      const done = h.checkinOkDay === today;
      out.checkin = {
        by: h.checkinBy,
        done,
        ...(!done && h.checkinAlertDay === today ? { alerted: true as const } : {}),
      };
    }
    if (h.chimeText) out.chime = { text: h.chimeText };
    if (h.intercom) {
      out.intercom = {
        room: peer.label.slice(0, 24),
        key: await store.home.intercomKey(this.householdId),
      };
    }
    return out;
  }

  /** Daily check-in: I'm OK, counted for the phone's local day (and its config says so). */
  private async checkinOk(device: DevicePeer): Promise<void> {
    const { store } = this.env;
    const h = await store.home.get(device.id);
    if (!h.checkinBy) return; // labs phones: nothing to count
    const space = await store.getHousehold(this.householdId);
    await store.home.checkedIn(
      device.id,
      localDay(new Date(this.env.now()), space?.timeZone ?? "UTC"),
    );
    this.env.log("info", "check-in ok", { device: device.id });
    await this.sendConfig(device, true);
  }

  /**
   * Phones whose daily check-in time passed today without I'm OK: their guardians are told (once
   * a day, kept in the store so a restart doesn't repeat it). Returns when to look again.
   */
  private async checkCheckins(): Promise<number | undefined> {
    const { store } = this.env;
    const rows = await store.home.checkins(this.householdId);
    if (!rows.length) return undefined;
    const now = this.env.now();
    const space = await store.getHousehold(this.householdId);
    const tz = space?.timeZone ?? "UTC";
    const today = localDay(new Date(now), tz);
    const { minutes } = localClock(new Date(now), tz);
    let next: number | undefined;
    for (const r of rows) {
      const step = checkinStep(r.checkinBy as string, {
        minutes,
        done: r.checkinOkDay === today,
        alerted: r.checkinAlertDay === today,
      });
      if (step.alert && (await store.home.alerted(r.deviceId, today))) {
        const device = await store.getDevice(r.deviceId);
        if (device) {
          await this.checkinMissed(
            {
              id: device.id,
              label: device.name,
              ...(device.ownerUserId ? { owner: device.ownerUserId } : {}),
            },
            r.checkinBy as string,
          );
          const peer = this.devices.get(device.id);
          if (peer) await this.sendConfig(peer, true);
        }
      }
      const at = now + step.nextInMin * 60_000 + 1000;
      next = next === undefined ? at : Math.min(next, at);
    }
    return next;
  }

  /** When the next daily check-in could be due (to wake then), without acting on it. */
  private async nextCheckin(): Promise<number | undefined> {
    const { store } = this.env;
    const rows = await store.home.checkins(this.householdId);
    if (!rows.length) return undefined;
    const now = this.env.now();
    const tz = (await store.getHousehold(this.householdId))?.timeZone ?? "UTC";
    const today = localDay(new Date(now), tz);
    const { minutes } = localClock(new Date(now), tz);
    let next: number | undefined;
    for (const r of rows) {
      const step = checkinStep(r.checkinBy as string, {
        minutes,
        done: r.checkinOkDay === today,
        alerted: r.checkinAlertDay === today,
      });
      const at = step.alert ? now : now + step.nextInMin * 60_000 + 1000;
      next = next === undefined ? at : Math.min(next, at);
    }
    return next;
  }

  /** Chime: the phone posts its words as a notice to every phone of the space (once a minute). */
  private async chime(device: DevicePeer): Promise<void> {
    const { store } = this.env;
    const h = await store.home.get(device.id);
    const lines = h.chimeText ? noticeLines(h.chimeText) : undefined;
    const now = this.env.now();
    if (!lines || "error" in lines) {
      device.conn.send({ t: "error", code: "bad_message", message: "this phone has no chime" });
      return;
    }
    if (now - (this.chimed.get(device.id) ?? 0) < 60_000) return; // pressed again: once a minute
    this.chimed.set(device.id, now);
    const n = await store.notices.create(
      {
        householdId: this.householdId,
        createdBy: null,
        authorName: device.label,
        lines: lines.lines,
        deviceIds: null,
        expiresAt: now + CHIME_MINUTES * 60_000,
      },
      now,
    );
    await store.workplace
      .audit({
        householdId: this.householdId,
        at: now,
        actorAccount: null,
        actorName: device.label,
        action: "notice.post",
        detail: { noticeId: n.id, minutes: CHIME_MINUTES, chime: true },
      })
      .catch(() => {});
    await this.updateNotices();
    await this.scheduleWake();
  }

  /** A team/org space with extensions: its phones' MENU offers "Dial extension". */
  private async hasExtensions(): Promise<boolean> {
    if (!(await this.isWorkplace())) return false;
    return (await this.env.store.workplace.extensions(this.householdId)).length > 0;
  }

  /** Who a phone belongs to and how it's used, for the strip's trust line. */
  private async ownerLine(peer: DevicePeer) {
    const { store } = this.env;
    const space = await store.getHousehold(this.householdId);
    if (!space) return undefined;
    const mode: OwnerMode = peer.lounge
      ? "lounge"
      : peer.owner
        ? "personal"
        : peer.left !== undefined
          ? "left"
          : "kids";
    const person = peer.owner ? (await store.getUser(peer.owner))?.name : peer.left?.trim();
    return {
      mode,
      space: space.name.slice(0, 64),
      ...(person ? { person: person.slice(0, 24) } : {}),
    };
  }

  /**
   * The hub's one alarm: the next quiet-hours change (while phones are connected), the end of
   * a disconnected Lounge phone's reconnect grace, or a rate-limited presence update that is now
   * allowed, whichever is first. Sleeping until then
   * instead of polling lets a Durable Object host hibernate in between.
   */
  private async scheduleWake(): Promise<void> {
    const { store } = this.env;
    const now = this.env.now();
    let at: number | undefined;
    if (this.devices.size > 0) {
      const next = nextQuietChange(await store.getSchedule(this.householdId), new Date(now));
      // A second of slack so the check lands after the boundary.
      if (next) at = next.getTime() + 1000;
    }
    // A Lounge session under the "end of day" policy ends at its day end.
    const dayEnd = await this.nextDayEnd();
    if (dayEnd !== undefined) at = at === undefined ? dayEnd : Math.min(at, dayEnd);
    const [firstOffline] = await store.offlineLoungeSessions(this.householdId);
    if (firstOffline?.offlineAt != null) {
      const graceEnd = firstOffline.offlineAt + LOUNGE_RECONNECT_GRACE_MS;
      at = at === undefined ? graceEnd : Math.min(at, graceEnd);
    }
    // Presence for connections that waited out its rate limit (the latest state only).
    const presenceDue = this.env.flushPresence
      ? await store.connections.nextPresenceDue(this.householdId)
      : undefined;
    if (presenceDue !== undefined) at = at === undefined ? presenceDue : Math.min(at, presenceDue);
    // Rooms: the next idle warning or drop.
    const roomDue = this.conf.nextDeadline(now);
    if (roomDue !== undefined) at = at === undefined ? roomDue : Math.min(at, roomDue);
    // Party lines with hours: the next opening, warning or closing.
    const hoursDue = await this.roomHoursDue();
    if (hoursDue !== undefined) at = at === undefined ? hoursDue : Math.min(at, hoursDue);
    // Notices: the next one to expire leaves the phones then.
    const noticeDue = nextNoticeExpiry(await store.notices.live(this.householdId, now), now);
    if (noticeDue !== undefined) at = at === undefined ? noticeDue : Math.min(at, noticeDue);
    // Public lines' call backs: a ring running out, a place expiring.
    const callbackDue = this.callbacksPending
      ? await store.lines.nextCallbackDeadline(this.householdId)
      : undefined;
    if (callbackDue !== undefined) at = at === undefined ? callbackDue : Math.min(at, callbackDue);
    // Daily check-ins: the next time one could be due.
    const checkinDue = await this.nextCheckin();
    if (checkinDue !== undefined) at = at === undefined ? checkinDue : Math.min(at, checkinDue);
    // Calls with add-ons: the first to reach its longest length.
    const addonDue = this.addonCallsDue();
    if (addonDue !== undefined) at = at === undefined ? addonDue : Math.min(at, addonDue);
    this.cancelWakeTimer?.();
    this.cancelWakeTimer = undefined;
    if (at === undefined) {
      this.env.wakeAt?.(null);
      return;
    }
    if (this.env.wakeAt) {
      this.env.wakeAt(at);
      return;
    }
    this.cancelWakeTimer = this.env.setTimer(() => void this.wake(), Math.max(0, at - now));
  }

  private statusMessage(
    deviceId: string,
    peer: DevicePeer | undefined,
    lastSeen: number,
  ): Extract<ServerToApp, { t: "device.status" }> {
    return {
      t: "device.status",
      deviceId,
      online: !!peer,
      lastSeen: peer ? this.env.now() : lastSeen,
      ...(peer?.status?.battery ? { battery: peer.status.battery } : {}),
      ...(peer?.status?.rssi !== undefined ? { rssi: peer.status.rssi } : {}),
      ...(peer?.status?.power ? { power: peer.status.power } : {}),
      ...(peer?.lounge?.session
        ? {
            lounge: {
              userId: peer.lounge.session.guest?.id ?? peer.lounge.session.userId,
              name: peer.lounge.session.name,
              since: peer.lounge.session.since,
            },
          }
        : {}),
    };
  }

  /** Phone status goes to guardians (all phones), a personal phone's owner, and for Lounge
   * phones to everyone. */
  private broadcastStatus(peer: DevicePeer, online: boolean): void {
    const msg = this.statusMessage(peer.id, online ? peer : undefined, this.env.now());
    for (const set of this.apps.values()) {
      for (const app of set) {
        if (app.guardian || app.id === peer.owner || peer.lounge) app.conn.send(msg);
      }
    }
  }

  // --- Lounge phones ------------------------------------------------------------------
  //
  // Takeover: the idle phone shows a QR code with a single-use nonce (replaced every minute and
  // after every use). A member scans it in the companion and sends `lounge.claim`; the phone
  // then flashes a random key that must be pressed on the phone within 30 s, so a photographed
  // code is useless from afar. The phone then stands for that person — it calls and is called
  // with exactly their permissions — until they log out or leave, it sits idle while hung up, a
  // new takeover starts, or it disconnects. Only the fact that a session happened is stored.

  private timers(deviceId: string) {
    let t = this.loungeTimers.get(deviceId);
    if (!t) {
      t = {};
      this.loungeTimers.set(deviceId, t);
    }
    return t;
  }

  private clearLoungeTimers(deviceId: string): void {
    const t = this.loungeTimers.get(deviceId);
    t?.proof?.();
    t?.idle?.();
    this.loungeTimers.delete(deviceId);
  }

  /** A live Lounge phone peer, or undefined if it went away meanwhile. */
  private liveLounge(device: DevicePeer): DevicePeer | undefined {
    return this.devices.get(device.id) === device && device.lounge ? device : undefined;
  }

  /**
   * Issues a fresh single-use takeover nonce. Only on demand — connect, the phone's
   * `lounge.refresh`, and after each use or failed proof — never on a server timer, so a quiet
   * Lounge phone lets the host sleep.
   */
  private issueNonce(device: DevicePeer): void {
    const lounge = device.lounge;
    if (!lounge) return;
    lounge.nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    lounge.nonceExpiresAt = this.env.now() + LOUNGE_NONCE_TTL_MS;
    this.remember(device);
    device.conn.send({ t: "lounge.idle", nonce: lounge.nonce, expiresAt: lounge.nonceExpiresAt });
  }

  /**
   * A reconnecting Lounge phone gets its session back if it left less than
   * LOUNGE_RECONNECT_GRACE_MS ago (or its old socket is only now being replaced).
   */
  private async resumeLounge(
    peer: DevicePeer,
    old: DevicePeer | undefined,
  ): Promise<{ userId: string; name: string; openToChat: boolean } | undefined> {
    const lounge = peer.lounge;
    if (!lounge) return undefined;
    const { store } = this.env;
    const now = this.env.now();
    const row = await store.openLoungeSession(peer.id);
    if (!row) return undefined;
    if (row.userId === null) {
      // A guest's session ends with the connection (see dropPeer).
      await store.endLoungeSession(row.id, "offline", now);
      return undefined;
    }
    const fresh = row.offlineAt === null || now - row.offlineAt < LOUNGE_RECONNECT_GRACE_MS;
    const user = fresh ? await store.getUser(row.userId) : undefined;
    if (!user) {
      await store.endLoungeSession(
        row.id,
        user === undefined && fresh ? "removed" : "offline",
        now,
      );
      this.tellUser(row.userId, peer.id, "offline");
      return undefined;
    }
    await store.setLoungeOffline(row.id, null);
    lounge.session = {
      id: row.id,
      userId: user.id,
      name: user.name,
      since: row.startedAt,
      openToChat: old?.lounge?.session?.openToChat ?? row.openToChat,
    };
    return { userId: user.id, name: user.name, openToChat: lounge.session.openToChat };
  }

  /** Ends sessions whose phone didn't come back within the grace period. */
  private async expireOfflineLounges(): Promise<void> {
    const now = this.env.now();
    for (const row of await this.env.store.offlineLoungeSessions(this.householdId)) {
      if (row.offlineAt === null || now - row.offlineAt < LOUNGE_RECONNECT_GRACE_MS) continue;
      if (this.devices.has(row.deviceId)) continue; // came back meanwhile
      await this.env.store.endLoungeSession(row.id, "offline", now);
      if (row.userId) this.tellUser(row.userId, row.deviceId, "offline");
    }
  }

  /** After the host slept: timers are gone, the state came back from the socket memo. */
  private rearmLounge(device: DevicePeer): void {
    const now = this.env.now();
    const challenge = device.lounge?.challenge;
    if (challenge) this.armProof(device, challenge.expiresAt - now);
    void this.touchIdle(device);
  }

  private armProof(device: DevicePeer, ms: number): void {
    const t = this.timers(device.id);
    t.proof?.();
    t.proof = this.env.setTimer(
      () =>
        void this.run(() => {
          const d = this.liveLounge(device);
          if (d) this.failChallenge(d, "timeout");
        }),
      Math.max(0, ms),
    );
  }

  private appSession(session: string): Peer | undefined {
    for (const set of this.apps.values()) for (const p of set) if (p.session === session) return p;
    return undefined;
  }

  /** Tells every open session of a person that their Lounge session ended. */
  private tellUser(userId: string, deviceId: string, reason: LoungeEndReason): void {
    for (const app of this.apps.get(userId) ?? []) {
      app.conn.send({ t: "lounge.progress", deviceId, step: "ended", reason });
    }
  }

  private async loungeClaim(app: Peer, deviceId: string, nonce: string): Promise<void> {
    const fail = (reason: LoungeFail) =>
      app.conn.send({ t: "lounge.progress", deviceId, step: "failed", reason });
    const device = this.devices.get(deviceId);
    const lounge = device?.lounge;
    if (!device || !lounge) return fail("not_found");
    if (this.env.now() >= lounge.nonceExpiresAt) {
      // The phone's code is stale: refuse, and give the phone a new one.
      if (!lounge.challenge) this.issueNonce(device);
      return fail("expired");
    }
    if (nonce !== lounge.nonce) return fail("expired");
    // Single use: the code in any photo of the phone is dead from here on.
    this.issueNonce(device);
    if (this.busy(device.key)) return fail("busy");
    const earlier = lounge.challenge;
    if (earlier) this.notifyClaimant(device, earlier, "failed", "timeout");
    const expiresAt = this.env.now() + LOUNGE_PROOF_MS;
    lounge.challenge = {
      userId: app.id,
      name: app.label,
      index: randomKey(),
      expiresAt,
      app: app.session,
    };
    this.remember(device);
    device.conn.send({ t: "lounge.challenge", index: lounge.challenge.index, expiresAt });
    app.conn.send({ t: "lounge.progress", deviceId, step: "press_key", expiresAt });
    this.armProof(device, LOUNGE_PROOF_MS);
  }

  private failChallenge(device: DevicePeer, reason: LoungeFail): void {
    const lounge = device.lounge;
    const challenge = lounge?.challenge;
    if (!lounge || !challenge) return;
    delete lounge.challenge;
    this.timers(device.id).proof?.();
    this.notifyClaimant(device, challenge, "failed", reason);
    // Back to the code (a fresh one: the scanned nonce was used up).
    this.issueNonce(device);
  }

  private async loungePress(device: DevicePeer, index: number): Promise<void> {
    const challenge = device.lounge?.challenge;
    if (!challenge) return;
    if (this.env.now() >= challenge.expiresAt) return this.failChallenge(device, "timeout");
    if (index !== challenge.index) return this.failChallenge(device, "wrong_key");
    delete device.lounge?.challenge;
    this.timers(device.id).proof?.();
    if (challenge.guest) return this.startGuestSession(device, challenge.guest);
    const user = await this.env.store.getUser(challenge.userId);
    if (!user || user.householdId !== this.householdId) return this.issueNonce(device);
    await this.startLoungeSession(device, user, challenge.app);
  }

  private async startLoungeSession(device: DevicePeer, user: User, appSession: string) {
    const lounge = device.lounge;
    if (!lounge) return;
    // A new takeover ends the current session, and a person is at one Lounge phone at a time.
    if (lounge.session) await this.endLoungeSession(device, "replaced");
    for (const other of this.devices.values()) {
      if (other.lounge?.session?.userId === user.id) await this.endLoungeSession(other, "replaced");
    }
    const now = this.env.now();
    const id = await this.env.store.startLoungeSession(
      { householdId: this.householdId, deviceId: device.id, userId: user.id },
      now,
    );
    lounge.session = { id, userId: user.id, name: user.name, since: now, openToChat: false };
    this.remember(device);
    device.conn.send({ t: "lounge.session", name: user.name, openToChat: false });
    await this.sendConfig(device, true);
    for (const app of this.apps.get(user.id) ?? []) {
      app.conn.send({ t: "lounge.progress", deviceId: device.id, step: "started" });
    }
    if (!this.appSession(appSession)) this.env.log("info", "lounge claimant went away");
    await this.announceMember(user.id);
    this.broadcastStatus(device, true);
    await this.touchIdle(device);
    await this.refreshIdleLounges();
    await this.scheduleWake();
  }

  /** Ends the session: calls on the phone end, and the phone forgets the person. */
  private async endLoungeSession(device: DevicePeer, reason: LoungeEndReason): Promise<void> {
    const lounge = device.lounge;
    const session = lounge?.session;
    if (!lounge || !session) return;
    delete lounge.session;
    this.timers(device.id).idle?.();
    this.remember(device);
    await this.env.store.endLoungeSession(session.id, reason, this.env.now());
    for (const room of [...this.rooms.values()]) {
      if (room.caller === device) await this.apply(room, { type: "hangup", by: room.state.caller });
      else if (room.calleePeer === device) {
        await this.apply(room, { type: "hangup", by: room.state.callee });
      } else if (!room.calleePeer && room.state.callee === userKey(session.userId)) {
        // Was ringing here for the person; it keeps ringing their other sessions.
        device.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
      }
    }
    device.conn.send({ t: "lounge.ended", reason });
    await this.sendConfig(device, true);
    this.issueNonce(device);
    if (session.guest) this.notifyGuest(session.guest, device.id, { step: "ended", reason });
    else {
      this.tellUser(session.userId, device.id, reason);
      await this.announceMember(session.userId);
    }
    this.broadcastStatus(device, true);
    await this.refreshIdleLounges();
  }

  /** Restarts the idle clock: it runs only while the phone is hung up and not in a call. */
  private async touchIdle(device: DevicePeer): Promise<void> {
    const t = this.timers(device.id);
    t.idle?.();
    t.idle = undefined;
    const session = device.lounge?.session;
    if (!session || device.hook === "up" || this.busy(device.key)) return;
    const settings = await this.env.store.loungeSettings(this.householdId);
    // Only the "idle" policy ends sessions on inactivity (end of day uses the hub's alarm).
    if (settings.session !== "idle") return;
    const minutes = settings.idleMinutes;
    t.idle = this.env.setTimer(
      () =>
        void this.run(async () => {
          const d = this.liveLounge(device);
          if (!d || d.lounge?.session?.id !== session.id) return;
          if (d.hook === "up" || this.busy(d.key)) return;
          await this.endLoungeSession(d, "idle");
        }),
      minutes * 60_000,
    );
  }

  /** When a session must end under the space's "end of day" policy, if that's the policy. */
  private async dayEndOf(since: number): Promise<number | undefined> {
    const settings = await this.env.store.loungeSettings(this.householdId);
    if (settings.session !== "end_of_day") return undefined;
    const tz = (await this.env.store.getHousehold(this.householdId))?.timeZone ?? "UTC";
    return loungeDayEnd(since, settings.dayEnd, tz);
  }

  /** Ends the sessions whose day is over ("end of day" policy; checked when the hub wakes). */
  private async endDayEndSessions(): Promise<void> {
    const now = this.env.now();
    for (const d of this.devices.values()) {
      const session = d.lounge?.session;
      if (!session) continue;
      const end = await this.dayEndOf(session.since);
      if (end !== undefined && now >= end) await this.endLoungeSession(d, "idle");
    }
  }

  /** The earliest end of day among open sessions (for the hub's one alarm). */
  private async nextDayEnd(): Promise<number | undefined> {
    let at: number | undefined;
    for (const d of this.devices.values()) {
      const session = d.lounge?.session;
      const end = session ? await this.dayEndOf(session.since) : undefined;
      if (end !== undefined) at = at === undefined ? end : Math.min(at, end);
    }
    return at;
  }

  /**
   * An idle Lounge phone (nobody signed in): its house-line keys and "who's here", both off
   * unless the space turns them on.
   */
  private async idleLoungeConfig(
    device: DevicePeer,
  ): Promise<{ buttons: { index: number; label: string }[]; houseLine?: true; here?: Here[] }> {
    const { idle } = await this.env.store.loungeSettings(this.householdId);
    const keys = idle.houseLine.enabled ? idle.houseLine.keys : [];
    const here: Here[] = [];
    if (idle.whosHere) {
      for (const d of this.devices.values()) {
        const s = d.lounge?.session;
        if (d !== device && s?.openToChat) here.push({ name: s.name, where: d.label.slice(0, 24) });
      }
    }
    return {
      buttons: keys.map((k) => ({ index: k.index, label: k.label })),
      ...(keys.length ? { houseLine: true as const } : {}),
      ...(idle.whosHere ? { here: here.slice(0, 8) } : {}),
    };
  }

  /** Idle Lounge phones show who's here: refresh them when someone comes, goes or opens up. */
  private async refreshIdleLounges(): Promise<void> {
    for (const d of this.devices.values()) {
      if (d.lounge && !d.lounge.session) await this.sendConfig(d, true);
    }
  }

  /**
   * A house-line key on an idle Lounge phone: calls as the space (the phone's name), to a
   * member, a personal desk phone, or a group of members. Only keys the space set up work.
   */
  private async houseLineDial(device: DevicePeer, index: number): Promise<void> {
    const { idle } = await this.env.store.loungeSettings(this.householdId);
    const key: HouseLineKey | undefined = idle.houseLine.enabled
      ? idle.houseLine.keys.find((k) => k.index === index)
      : undefined;
    if (!key) return this.refuse(device, "denied");
    const as = { id: device.id, label: device.label };
    const target = key.target;
    // Saved before free phones stopped calling lines: refused as the line rule says.
    if (target.kind === "line") return this.lineDial(device, target.address);
    if (target.kind === "user") return this.userDial(device, target.userId, as);
    if (target.kind === "device") return this.houseLinePhone(device, target.deviceId);
    return this.groupDial(device, target.userIds);
  }

  /** Rings a personal (desk) phone in this space from the house line. */
  private async houseLinePhone(device: DevicePeer, deviceId: string): Promise<void> {
    const { store } = this.env;
    const target = await store.getDevice(deviceId);
    if (!target || target.householdId !== this.householdId || deviceMode(target) !== "personal") {
      return this.refuse(device, "denied");
    }
    const owner = target.ownerUserId as string;
    if (!((await store.availability(this.householdId)).get(owner) ?? true)) {
      return this.refuse(device, "unavailable");
    }
    const peer = this.devices.get(deviceId);
    if (!peer) return this.refuse(device, "unreachable");
    if (this.busy(peer.key) || peer.hook === "up") return this.refuse(device, "busy");
    const allowance = await this.allowance(device);
    if (allowance.note) return this.refuse(device, "denied", allowance.note);
    const room = this.openRoom(device, peer.key, undefined, await this.personRingMs(owner));
    room.payer = allowance.payer;
    room.calleePeer = peer;
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: device.label } });
  }

  /** Rings every available member of a house-line group; the first to answer takes the call. */
  private async groupDial(device: DevicePeer, userIds: string[]): Promise<void> {
    const { store } = this.env;
    const availability = await store.availability(this.householdId);
    const members = userIds.filter(
      (u) => availability.has(u) && availability.get(u) && !this.busy(userKey(u)),
    );
    const targets = members.flatMap((u) => this.reachable(u, device));
    if (!targets.length) return this.refuse(device, "unreachable");
    const allowance = await this.allowance(device);
    if (allowance.note) return this.refuse(device, "denied", allowance.note);
    const room = this.openRoom(device, `grp:${device.id}`);
    room.payer = allowance.payer;
    room.group = members;
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(room, targets, [], device.label);
  }

  private async loungeDial(device: DevicePeer, index: number): Promise<void> {
    const session = device.lounge?.session;
    if (!session) return this.houseLineDial(device, index);
    const entry = (await this.sessionDirectory(session)).get(index);
    if (!entry) return this.refuse(device, "denied");
    if (entry.kind === "address" && session.guest) {
      return this.guestDial(device, session.guest, entry);
    }
    const as = { id: session.userId, label: session.name };
    if (entry.kind === "line") return this.addressDial(device, entry.id);
    if (entry.kind === "device") return this.appDial(device, entry.id, as);
    if (entry.kind === "connection") return this.connectionDial(device, entry.id, as);
    return this.userDial(device, entry.id, as);
  }

  /** Speed-dial for whoever is at a Lounge phone: a member's, or the directory a guest brought. */
  private async sessionDirectory(
    session: NonNullable<LoungeInfo["session"]>,
  ): Promise<Map<number, LoungeEntry>> {
    if (!session.guest) return this.loungeDirectory(session.userId);
    const out = new Map<number, LoungeEntry>();
    for (const [i, d] of session.guest.directory.slice(0, 10).entries()) {
      out.set(i, { kind: "address", id: d.address, label: d.name.slice(0, 24) });
    }
    return out;
  }

  /**
   * A person's speed-dial on a Lounge phone: their own phone's keys if they have one, otherwise
   * the household phones they may call, then the other members. Button index → entry.
   */
  private async loungeDirectory(userId: string): Promise<Map<number, LoungeEntry>> {
    const { store } = this.env;
    const out = new Map<number, LoungeEntry>();
    const devices = await store.listDevices(this.householdId);
    const own = devices.find((d) => d.ownerUserId === userId);
    if (own) {
      const [buttons, contacts] = await Promise.all([
        store.listButtons(own.id),
        store.listContacts(own.id),
      ]);
      const byId = new Map(contacts.map((c) => [c.id, c]));
      const remote = new Map((await store.listRemoteContacts(own.id)).map((r) => [r.id, r]));
      const lines = new Map((await store.lines.onPhone(own.id)).map((l) => [l.id, l]));
      for (const [index, id] of buttons) {
        const c = byId.get(id);
        if (!c?.deviceCanCall || id === userId) continue;
        if (!validKeyIndex(index, limitsOf(this.env).keyPages)) continue;
        const line = lines.get(id);
        if (line) {
          out.set(index, { kind: "line", id: line.address, label: c.label });
          continue;
        }
        const via = remote.get(id);
        if (via) out.set(index, { kind: "connection", id: via.connectionId, label: c.label });
        else out.set(index, { kind: "user", id, label: c.label });
      }
      return out;
    }
    const entries: LoungeEntry[] = [];
    for (const d of devices) {
      if (d.ownerUserId || d.kind === "lounge") continue;
      if ((await store.getContact(d.id, userId))?.canCallDevice) {
        entries.push({ kind: "device", id: d.id, label: d.name });
      }
    }
    for (const u of await store.listUsers(this.householdId)) {
      if (u.id !== userId) entries.push({ kind: "user", id: u.id, label: u.name });
    }
    // Then the people they're connected with in other households and on other servers.
    const user = await store.getUser(userId);
    const connections = user ? await store.connections.list(user.accountId) : [];
    for (const c of connections) {
      if (c.state !== "active" || !c.peerAccount) continue;
      entries.push({
        kind: "connection",
        id: c.id,
        label: (c.peerName || c.peerHandle).slice(0, 24),
      });
    }
    // Ten to a page, as many pages as a phone may have (the phone shows the first page only
    // unless it lists `key-pages`).
    const max = Math.min(limitsOf(this.env).keyPages, MAX_KEY_PAGES) * KEYS_PER_PAGE;
    for (const [i, e] of entries.slice(0, max).entries()) out.set(i, e);
    return out;
  }

  /** Who a party is, from the other side's point of view (for the call log). */
  private async describe(
    peer: Peer | undefined,
    key: string,
  ): Promise<{ peer: string; label: string }> {
    if (peer?.kind === "remote") {
      // An add-on elsewhere is logged as itself, not as its owner.
      const address = peer.addon?.address ?? peer.address;
      return { peer: address ?? (peer.host || ownHost(this.env)), label: peer.label };
    }
    if (peer?.kind === "addon" && peer.addon) {
      return { peer: peer.addon.address, label: peer.label };
    }
    if (peer?.kind === "device") return { peer: `device:${peer.id}`, label: peer.label };
    const userId = peer?.kind === "user" ? peer.id : key.startsWith("usr:") ? idOf(key) : undefined;
    if (!userId) return { peer: key, label: peer?.label ?? "" };
    const user = await this.env.store.getUser(userId);
    return { peer: `user:${userId}`, label: user?.name ?? peer?.label ?? "" };
  }

  /** One call-log row for each party on this server (a person's, or a phone's own). */
  private async logCall(room: Room, reason: string): Promise<void> {
    const { store } = this.env;
    const now = this.env.now();
    const durationMs = room.activeAt !== undefined ? now - room.activeAt : 0;
    const sides = [
      {
        self: room.caller as Peer | undefined,
        selfKey: room.state.caller,
        other: room.calleePeer,
        otherKey: room.state.callee,
        direction: "out" as const,
      },
      {
        self: room.calleePeer,
        selfKey: room.state.callee,
        other: room.caller as Peer | undefined,
        otherKey: room.state.caller,
        direction: "in" as const,
      },
    ];
    for (const side of sides) {
      if (side.self?.kind === "remote") continue;
      let accountId: string | null = null;
      let deviceId: string | null = null;
      if (side.self?.kind === "device") {
        deviceId = side.self.id;
        const person = personOf(side.self);
        if (person && !person.startsWith("guest:")) {
          accountId = (await store.getUser(person))?.accountId ?? null;
        }
      } else {
        const userId =
          side.self?.kind === "user"
            ? side.self.id
            : side.selfKey.startsWith("usr:")
              ? idOf(side.selfKey)
              : undefined;
        if (!userId) continue;
        accountId = (await store.getUser(userId))?.accountId ?? null;
        if (!accountId) continue;
      }
      const other =
        !side.other && side.otherKey.startsWith("hg:")
          ? { peer: `group:${idOf(side.otherKey)}`, label: room.hunt?.name ?? "Group" }
          : await this.describe(side.other, side.otherKey);
      await store.logCall({
        householdId: this.householdId,
        accountId,
        deviceId,
        peer: other.peer,
        peerLabel: other.label,
        direction: side.direction,
        startedAt: room.startedAt ?? now,
        answered: room.answered === true,
        durationMs,
        endReason: reason,
        callId: room.id,
      });
    }
  }

  // --- add-ons (docs/add-ons.md) ------------------------------------------------------------

  /**
   * One of this household's add-ons connected (after its signed challenge). It gets a `config`
   * that says who it is and whose it is; its calls are handled like a phone's, without keys.
   */
  connectAddon(addon: Addon, conn: Conn): Promise<Peer> {
    return this.run(async () => {
      const { store } = this.env;
      const old = this.addonPeers.get(addon.id);
      if (old) {
        this.dropPeer(old, true);
        old.conn.close(CloseCode.replaced, "replaced by a newer connection");
      }
      const [account, owner] = await Promise.all([
        store.getAccount(addon.accountId),
        store.getUser(addon.userId),
      ]);
      const handle = account?.handle ?? "";
      const peer: Peer = {
        session: newId("s"),
        householdId: this.householdId,
        kind: "addon",
        id: addon.id,
        key: addonKey(addon.id),
        label: addon.name.slice(0, 24),
        conn,
        guardian: false,
        addon: {
          name: addon.name,
          address: addonAddress(this.env, handle, addon.name),
          accountId: addon.accountId,
          ownerUserId: addon.userId,
          rules: rulesOf(this.env, addon.about),
        },
      };
      this.addonPeers.set(addon.id, peer);
      conn.send({
        t: "config",
        buttons: [],
        quiet: false,
        now: this.env.now(),
        server: serverInfo(this.env),
        addon: {
          name: addon.name,
          address: addonAddress(this.env, handle, addon.name),
          owner: {
            name: (owner?.name ?? account?.name ?? handle).slice(0, 64),
            address: `${handle}@${ownHost(this.env)}`,
          },
        },
      });
      this.remember(peer);
      return peer;
    });
  }

  /**
   * What an add-on may send (`ADDON_MESSAGES`, an allow-list): call control for its own calls,
   * `call.address`, what it says about itself and its shares. Anything else is refused with an
   * `error` and does nothing; so is everything past its per-minute message limit, which also
   * closes the socket.
   */
  private async handleAddon(peer: Peer, msg: DeviceToServer): Promise<void> {
    if (this.addonPeers.get(peer.id) !== peer) return;
    if (!this.addonWithinMessages(peer)) return;
    if (!ADDON_MESSAGES.has(msg.t)) {
      peer.conn.send({
        t: "error",
        code: "bad_message",
        message: `not for add-ons: ${msg.t}`,
        ...(msg.id ? { ref: msg.id } : {}),
      });
      return;
    }
    switch (msg.t) {
      case "ping":
        peer.conn.send({ t: "pong" });
        return;
      case "call.address":
        return this.addonCall(peer, msg.address, msg.share);
      case "call.answer":
      case "call.hangup":
        return this.callMessage(peer, msg);
      case "rtc.sdp":
      case "rtc.ice":
        if (msg.peer) break;
        return this.callMessage(peer, msg);
      case "addon.shares":
        return this.addonShares(peer, msg.shares);
      case "addon.share.created":
      case "addon.share.refused":
        return this.addonShareAnswer(peer, msg);
      case "addon.about":
        return this.addonAbout(peer, msg);
      case "addon.test.ok":
        return this.addonTestAnswer(peer, msg);
      default:
        break;
    }
    peer.conn.send({
      t: "error",
      code: "bad_message",
      message: `not for add-ons: ${msg.t}`,
      ...(msg.id ? { ref: msg.id } : {}),
    });
  }

  /**
   * Still linked? A removed add-on (or one whose owner left the space) is told to forget its link
   * and closed, and nothing reaches it.
   */
  private async addonStillLinked(peer: Peer): Promise<Addon | undefined> {
    const addon = this.env.addons ? await this.env.store.addons.get(peer.id) : undefined;
    if (addon) return addon;
    if (this.env.addons) peer.conn.send({ t: "wipe", reason: "removed" });
    this.dropPeer(peer);
    peer.conn.close(CloseCode.unauthorized, "removed");
    return undefined;
  }

  /** Messages counted per add-on connection (in a one-minute window). */
  private readonly addonMessages = new WeakMap<Peer, { since: number; count: number }>();

  /** Within its per-minute message limit; over it, it's told once and its socket closes. */
  private addonWithinMessages(peer: Peer): boolean {
    const now = this.env.now();
    const w = this.addonMessages.get(peer);
    if (!w || now - w.since >= 60_000) {
      this.addonMessages.set(peer, { since: now, count: 1 });
      return true;
    }
    w.count += 1;
    if (w.count <= limitsOf(this.env).addonMessagesPerMinute) return true;
    if (this.addonPeers.get(peer.id) === peer) {
      peer.conn.send({ t: "error", code: "rate_limited", message: "too many messages" });
      this.dropPeer(peer);
      peer.conn.close(CloseCode.tooMuch, "too many messages");
    }
    return false;
  }

  /** What the server lets this add-on do now. */
  private rulesFor(peer: Peer) {
    return peer.addon?.rules ?? rulesOf(this.env, null);
  }

  /**
   * The add-on says what it does (`addon.about`): kept for its page in the app, and the rules
   * the server enforces follow it at once (calls, shares, keys, calls at once).
   */
  private async addonAbout(
    peer: Peer,
    msg: Extract<DeviceToServer, { t: "addon.about" }>,
  ): Promise<void> {
    const addon = await this.addonStillLinked(peer);
    if (!addon || !peer.addon) return;
    const self = selfOf(msg);
    if (typeof self === "string") {
      peer.conn.send({
        t: "error",
        code: "bad_message",
        message: self,
        ...(msg.id ? { ref: msg.id } : {}),
      });
      return;
    }
    await this.env.store.addons.setAbout(addon.id, self);
    peer.addon.rules = rulesOf(this.env, self);
    this.remember(peer);
    // It says it offers no shares: those it offered go (with their grants and calls).
    if (!self.shares && (await this.env.store.addons.shares(addon.id)).length) {
      await this.applyShares(peer, addon, []);
    }
    void this.env.calls
      ?.notifyAccount(addon.accountId, { t: "connections.changed" })
      .catch(() => {});
  }

  /**
   * The add-on says what it offers for sharing (`addon.shares`). A share it dropped goes with its
   * grants: calls into it end now, and the people who held it are told.
   */
  private async addonShares(peer: Peer, shares: { id: string; label: string }[]): Promise<void> {
    const addon = await this.addonStillLinked(peer);
    if (!addon) return;
    const refuse = (message: string) =>
      peer.conn.send({ t: "error", code: "bad_message", message });
    if (shares.length && !this.rulesFor(peer).shares) {
      return refuse("it said it offers no shares (addon.about)");
    }
    const clean: { id: string; label: string }[] = [];
    for (const x of shares) {
      const label = cleanText(x.label, 40);
      if (label === null) return refuse(`share ${x.id}: use plain words for its label`);
      clean.push({ id: x.id, label });
    }
    const ok = await this.env.store.connections.hit(
      `addon-shares:${addon.id}`,
      HOUR_MS,
      limitsOf(this.env).addonShareUpdatesPerHour,
      this.env.now(),
    );
    if (!ok) {
      peer.conn.send({ t: "error", code: "rate_limited", message: "too many share updates" });
      return;
    }
    await this.applyShares(peer, addon, clean);
  }

  private async applyShares(
    _peer: Peer,
    addon: Addon,
    shares: { id: string; label: string }[],
  ): Promise<void> {
    const before = await this.env.store.addons.shares(addon.id);
    const { revoked, removed } = await this.env.store.addons.setShares(addon.id, shares);
    if (removed.length) await this.endShareCalls(addon.id, { shareIds: removed });
    // Holders here of a share it stopped offering get a note that it went.
    for (const g of revoked) {
      const label = before.find((b) => b.id === g.shareId)?.label ?? "";
      await noteShareGone(this.env, addon, g, label, "not_offered");
    }
    const told = new Set<string>();
    for (const g of revoked) {
      const key = `${g.host}|${g.accountId}`;
      if (told.has(key)) continue;
      told.add(key);
      this.env.defer(
        tellHolder(
          this.env,
          (id, m) => this.env.calls?.notifyAccount(id, m) ?? Promise.resolve(),
          addon.accountId,
          g,
        ),
      );
    }
    // A share whose label changed: its holders here see the new one.
    for (const g of await this.env.store.addons.grants(addon.id)) {
      const key = `${g.host}|${g.accountId}`;
      if (told.has(key) || g.host !== LOCAL_HOST) continue;
      told.add(key);
      void this.env.calls?.notifyAccount(g.accountId, { t: "connections.changed" }).catch(() => {});
    }
  }

  /** The add-on answers its owner's "Ask it for a new share…". */
  private async addonShareAnswer(
    peer: Peer,
    msg:
      | { t: "addon.share.created"; requestId: string; id: string }
      | { t: "addon.share.refused"; requestId: string; reason: string },
  ): Promise<void> {
    const addon = await this.addonStillLinked(peer);
    if (!addon) return;
    let answer: { requestId: string } & ({ id: string } | { reason: string });
    if (msg.t === "addon.share.created") answer = { requestId: msg.requestId, id: msg.id };
    else {
      const reason = cleanText(msg.reason, 200);
      if (reason === null) {
        peer.conn.send({ t: "error", code: "bad_message", message: "reason: use plain words" });
        return;
      }
      answer = { requestId: msg.requestId, reason };
    }
    // Granting tells other servers: not inside this hub's queue.
    this.env.defer(
      answerShareRequest(
        this.env,
        (id, m) => this.env.calls?.notifyAccount(id, m) ?? Promise.resolve(),
        addon,
        answer,
      ).then((problem) => {
        if (problem) peer.conn.send({ t: "error", code: "bad_message", message: problem });
      }),
    );
  }

  /** Sends one of our add-ons its owner's share request; false when it isn't connected. */
  /**
   * Test connection: asks one of our add-ons `addon.test` and waits (outside the hub's queue) up
   * to `ADDON_TEST_TIMEOUT_MS` for its `addon.test.ok`. No call is placed.
   */
  addonTest(addonId: string): Promise<AddonTestResult> {
    return new Promise((resolve) => {
      void this.run(() => {
        const peer = this.addonPeers.get(addonId);
        if (!peer) return resolve({ state: "offline" });
        const testId = newId("at");
        const cancel = this.env.setTimer(() => {
          if (this.addonTests.delete(testId)) resolve({ state: "timeout" });
        }, ADDON_TEST_TIMEOUT_MS);
        this.addonTests.set(testId, {
          addonId,
          sentAt: this.env.now(),
          done: (r) => {
            cancel();
            resolve(r);
          },
        });
        peer.conn.send({ t: "addon.test", testId });
      });
    });
  }

  /** An add-on answered a test: how long it took and what it said. A late or stray one: nothing. */
  private addonTestAnswer(peer: Peer, msg: Extract<DeviceToServer, { t: "addon.test.ok" }>): void {
    const test = this.addonTests.get(msg.testId);
    if (!test || test.addonId !== peer.id) return;
    this.addonTests.delete(msg.testId);
    const version = msg.version === undefined ? null : cleanText(msg.version, 64);
    test.done({
      state: "ok",
      ms: Math.max(0, this.env.now() - test.sentAt),
      ...(version ? { version } : {}),
      ...(msg.uptimeS !== undefined ? { uptimeS: msg.uptimeS } : {}),
      ...(msg.calls !== undefined ? { calls: msg.calls } : {}),
    });
  }

  addonShareRequest(addonId: string, msg: ServerToDevice): Promise<boolean> {
    return this.run(() => {
      const peer = this.addonPeers.get(addonId);
      if (!peer) return false;
      peer.conn.send(msg);
      return true;
    });
  }

  /** Ends calls with one of our add-ons through these grants, or within these shares. */
  endAddonShareCalls(
    addonId: string,
    which: { grantIds?: string[]; shareIds?: string[] },
  ): Promise<void> {
    return this.run(() => this.endShareCalls(addonId, which));
  }

  private async endShareCalls(
    addonId: string,
    which: { grantIds?: string[]; shareIds?: string[] },
  ): Promise<void> {
    const key = addonKey(addonId);
    for (const room of [...this.rooms.values()]) {
      const s = room.addonShare;
      if (!s || (room.caller.key !== key && room.state.callee !== key)) continue;
      const hit =
        (s.grantId !== undefined && which.grantIds?.includes(s.grantId)) ||
        which.shareIds?.includes(s.id);
      if (hit) await this.apply(room, { type: "end", reason: "unavailable" });
    }
  }

  /** A phone's address key (or a Lounge session's): an add-on, else a public line. */
  private async addressDial(peer: Peer, address: string): Promise<void> {
    const addon = parseAddonAddress(address);
    return addon ? this.addonDial(peer, addon) : this.lineDial(peer, address);
  }

  /**
   * Someone here calls an add-on by its address: from their app, or from their own phone (a key),
   * or a Lounge phone they're signed in at. Only its owner or a connection its owner allowed;
   * never a kids' phone. Someone who may not call it learns only `CANT_CALL_NOTE`, whether it
   * exists or not; its owner and holders learn why it didn't ring (core/refusals.ts).
   */
  private async addonDial(peer: Peer, addr: AddonAddress): Promise<void> {
    const { store } = this.env;
    if (this.isKidsPhone(peer)) return this.refuse(peer, "denied", KIDS_NO_ADDONS);
    if (this.strictPhone(peer)) return this.refuse(peer, "denied", LEFT_PHONE_CANT_NOTE);
    if (peer.kind === "addon") return this.refuse(peer, "unavailable");
    if (!this.env.addons) return this.refuse(peer, "unavailable", ADDONS_OFF_NOTE);
    const as = await this.callingAs(peer);
    const user = as && (await store.getUser(as.id));
    const account = user && (await store.getAccount(user.accountId));
    if (!as || !account) return this.refuse(peer, "denied");
    if (!this.canDial(peer)) return this.refuse(peer, "busy", CALLER_BUSY_NOTE);
    const host = addr.host === ownHost(this.env) ? LOCAL_HOST : addr.host;
    const share = addr.share;
    const body = {
      from: partyOf(account),
      to: {
        kind: "addon" as const,
        handle: addr.handle,
        name: addr.name,
        ...(share ? { share } : {}),
      },
    };
    const label = addr.name.slice(0, 24);
    const callee = {
      name: addr.name,
      address: formatAddonAddress({ ...addr, host: ownHost(this.env) }),
    };
    if (host !== LOCAL_HOST) {
      return this.dialRemote(peer, {
        as,
        host,
        key: `fed:${host}:addon:${addr.handle}+${addr.name}`,
        label,
        peerHousehold: undefined,
        body,
        addon: { name: addr.name, address: formatAddonAddress(addr) },
      });
    }
    const addon = await store.addons.byAddress(addr.handle, addr.name);
    if (!addon) {
      // Only the handle's own account learns that nothing is linked under it here.
      const own = addr.handle.toLowerCase() === account.handle;
      return this.refuse(peer, "unavailable", own ? ADDON_NOT_LINKED_NOTE : CANT_CALL_NOTE);
    }
    if (addon.householdId !== this.householdId) {
      // Linked in another household here: its hub decides, as for a call from elsewhere.
      return this.dialRemote(peer, {
        as,
        host: LOCAL_HOST,
        key: addonKey(addon.id),
        label,
        peerHousehold: addon.householdId,
        body,
        addon: callee,
        free: true,
      });
    }
    const who = { host: LOCAL_HOST, accountId: account.id, handle: account.handle };
    const access = await addonAccess(this.env, addon, who, share);
    if (!access) return this.refuse(peer, "unavailable", CANT_CALL_NOTE);
    const target = this.addonPeers.get(addon.id);
    if (target && !this.rulesFor(target).answers) {
      return this.refuse(peer, "unavailable", ADDON_NO_CALLS_NOTE);
    }
    const limited = await addonCallerLimited(this.env, addon, who);
    if (limited) return this.refuse(peer, "denied", limited);
    if (!target) return this.refuse(peer, "unreachable", ADDON_OFFLINE_NOTE);
    if (this.addonFull(target)) return this.refuse(peer, "busy", ADDON_FULL_NOTE);
    const note = await fairUseProblem(this.env, addon.accountId, "call");
    if (note) return this.refuse(peer, "denied", note);
    const room = this.openRoom(peer, target.key);
    room.payer = addon.accountId;
    room.calleePeer = target;
    if (access.share) room.addonShare = access.share;
    this.roomsDirty = true;
    peer.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    target.conn.send({
      t: "call.ringing",
      callId: room.id,
      from: { label: as.label.slice(0, 24), address: `${account.handle}@${ownHost(this.env)}` },
      ...(access.share ? { share: access.share } : {}),
    });
  }

  /**
   * Rings one of our add-ons for a caller in another household here or on another server,
   * already authorized by `FedCalls.receive`. Its owner's allowance pays.
   */
  private async ringAddon(
    remote: Peer,
    callId: string,
    target: {
      addonId: string;
      accountId: string;
      share?: { id: string; label: string; grantId: string };
    },
    label: string,
    address: string,
  ): Promise<RingResult> {
    const peer = this.addonPeers.get(target.addonId);
    if (!peer || !(await this.addonStillLinked(peer))) {
      return { state: "ended", reason: "unreachable", note: ADDON_OFFLINE_NOTE };
    }
    if (!this.rulesFor(peer).answers) {
      return { state: "ended", reason: "unavailable", note: ADDON_NO_CALLS_NOTE };
    }
    if (this.addonFull(peer)) return { state: "ended", reason: "busy", note: ADDON_FULL_NOTE };
    const note = await fairUseProblem(this.env, target.accountId, "call");
    if (note) return { state: "ended", reason: "denied", note };
    const room = this.openRoom(remote, peer.key, callId);
    room.payer = target.accountId;
    room.calleePeer = peer;
    if (target.share) room.addonShare = target.share;
    this.roomsDirty = true;
    peer.conn.send({
      t: "call.ringing",
      callId: room.id,
      from: { label: label.slice(0, 24), ...(address ? { address } : {}) },
      ...(target.share ? { share: target.share } : {}),
    });
    return { state: "ringing" };
  }

  /**
   * An add-on calls by address (`call.address`): its owner, or, within one of its shares
   * (`share`), someone who holds that share. People only (apps, own phones, Lounge sessions):
   * never a phone of a space, so never a kids' phone. Everything else ends `unavailable`.
   */
  private async addonCall(peer: Peer, address: string, shareId?: string): Promise<void> {
    const { store } = this.env;
    const addon = await this.addonStillLinked(peer);
    if (!addon) return;
    const addr = parseAddress(address);
    const account = await store.getAccount(addon.accountId);
    if (!addr || !account || !this.rulesFor(peer).calls) return this.refuse(peer, "unavailable");
    // Its owner must still be in good standing for it to call anyone (even them).
    const ownerHere = { host: LOCAL_HOST, accountId: account.id, handle: account.handle };
    if (!(await addonAccess(this.env, addon, ownerHere))) return this.refuse(peer, "unavailable");
    const share = shareId ? await store.addons.share(addon.id, shareId) : undefined;
    if (shareId && !share) return this.refuse(peer, "unavailable");
    const host = addr.host === ownHost(this.env) ? LOCAL_HOST : addr.host;
    const as = { id: addon.userId, label: peer.label };
    const opts = share ? { addonShare: { id: share.id, label: share.label } } : {};
    /** One call at a time, and its hourly and per-person limits (refusals say why). */
    const limited = async (callee: { host: string; accountId: string }) => {
      if (!this.canDial(peer)) return this.refuse(peer, "busy", CALLER_BUSY_NOTE).then(() => true);
      const note = await addonCallsOutLimited(this.env, addon, callee);
      return note ? this.refuse(peer, "denied", note).then(() => true) : false;
    };
    if (host === LOCAL_HOST && addr.handle === account.handle) {
      // Its owner: wherever they can be rung, like any call to them.
      if (await limited(ownerHere)) return;
      return this.userDial(peer, addon.userId, { id: addonKey(addon.id), label: peer.label }, opts);
    }
    if (!share) return this.refuse(peer, "unavailable");
    if (host === LOCAL_HOST) {
      // Someone here who holds the share (a connection, or someone in one of the owner's spaces),
      // unless they stopped its calls.
      const holder = await store.accountByHandle(addr.handle);
      const who = holder && { host, accountId: holder.id, handle: holder.handle };
      const access = who && (await addonAccess(this.env, addon, who, share.id));
      if (!holder || !access?.share) return this.refuse(peer, "unavailable");
      const mute = { host: LOCAL_HOST, ownerAccount: addon.accountId, name: addon.name };
      if (await store.addons.muted(holder.id, mute)) return this.refuse(peer, "unavailable");
      if (await limited({ host, accountId: holder.id })) return;
      const held = { addonShare: access.share };
      const here = await store.membership(holder.id, this.householdId);
      if (here) {
        return this.userDial(peer, here.id, { id: addonKey(addon.id), label: peer.label }, held);
      }
      const home = await primaryHousehold(this.env, holder.id);
      if (!home) return this.refuse(peer, "unreachable");
      return this.dialRemote(peer, {
        as,
        host: LOCAL_HOST,
        key: `fed::${holder.id}`,
        label: (holder.name || holder.handle).slice(0, 24),
        peerHousehold: home.household.id,
        body: { from: partyOf(account), to: { kind: "person", handle: holder.handle } },
        ...held,
      });
    }
    const conn = await store.connections.find(addon.accountId, host, addr.handle);
    const who = conn?.peerAccount
      ? { host, accountId: conn.peerAccount, handle: conn.peerHandle }
      : undefined;
    const access = who && (await addonAccess(this.env, addon, who, share.id));
    if (!conn || !who || !access?.share) return this.refuse(peer, "unavailable");
    if (await limited(who)) return;
    return this.connectionDial(peer, conn.id, as, { addonShare: access.share });
  }

  /** A call with an add-on (ours, or one elsewhere). */
  private isAddonRoom(room: Room): boolean {
    return isAddonParty(room.caller) || isAddonParty(room.calleePeer);
  }

  /** It is taking as many calls as it may at once (`lines`). */
  private addonFull(peer: Peer): boolean {
    let n = 0;
    for (const r of this.rooms.values()) {
      if (r.caller === peer || r.calleePeer === peer || r.state.callee === peer.key) n++;
    }
    return n >= this.rulesFor(peer).lines;
  }

  /** When the first live call with an add-on reaches its longest length. */
  private addonCallsDue(): number | undefined {
    const max = limitsOf(this.env).addonCallMinutes * 60_000;
    let due: number | undefined;
    for (const r of this.rooms.values()) {
      if (r.activeAt === undefined || !this.isAddonRoom(r)) continue;
      const at = r.activeAt + max;
      due = due === undefined ? at : Math.min(due, at);
    }
    return due;
  }

  private async endLongAddonCalls(): Promise<void> {
    const max = limitsOf(this.env).addonCallMinutes * 60_000;
    const now = this.env.now();
    for (const r of [...this.rooms.values()]) {
      if (r.activeAt === undefined || !this.isAddonRoom(r) || now < r.activeAt + max) continue;
      r.endNote = ADDON_CALL_LIMIT_NOTE;
      await this.apply(r, { type: "end", reason: "hangup" });
    }
  }

  /**
   * One of our add-ons may have lost its standing (its owner suspended or gone, the link removed,
   * add-ons turned off): it's cut off now, with its calls. Removed: told to forget its link.
   */
  private async recheckAddon(peer: Peer): Promise<void> {
    const addon = await this.addonStillLinked(peer);
    if (!addon) return;
    const owner = { host: LOCAL_HOST, accountId: addon.accountId, handle: "" };
    if (await addonAccess(this.env, addon, owner)) return;
    peer.conn.send({
      t: "error",
      code: "unauthorized",
      message: "its owner's account can't use it now",
    });
    this.dropPeer(peer);
    peer.conn.close(CloseCode.unauthorized, "owner suspended");
  }

  /** A key pressed during a call: passed on only to an add-on (here, or through its server). */
  private callKey(peer: Peer, msg: { callId: string; key: string }): void {
    const room = this.rooms.get(msg.callId);
    const party = room && this.partyOf(room, peer);
    if (!room || !party || room.state.phase !== "active") return;
    const other = party === "caller" ? room.calleePeer : room.caller;
    if (other && isAddonParty(other) && (other.kind !== "addon" || this.rulesFor(other).keys)) {
      other.conn.send({ t: "call.key", callId: room.id, key: msg.key });
    }
  }

  // --- calls with other households and servers ------------------------------------------------

  private remotePeer(info: {
    host: string;
    key: string;
    label: string;
    peerHousehold?: string | undefined;
    leg?: string;
    address?: string;
    loungeRelay?: boolean;
    transferred?: boolean;
    kidsPhone?: boolean;
    line?: boolean;
    addon?: { name: string; address: string } | undefined;
  }): Peer {
    return this.remoteFromInfo({
      session: newId("s"),
      householdId: this.householdId,
      kind: "remote",
      id: newId("rem"),
      label: info.label,
      guardian: false,
      host: info.host,
      ...(info.peerHousehold ? { peerHousehold: info.peerHousehold } : {}),
      ...(info.leg ? { leg: info.leg } : {}),
      ...(info.address ? { address: info.address } : {}),
      ...(info.loungeRelay ? { loungeRelay: true } : {}),
      ...(info.transferred ? { transferred: true } : {}),
      ...(info.kidsPhone ? { kidsPhone: true } : {}),
      ...(info.line ? { line: true } : {}),
      ...(info.addon ? { addon: info.addon } : {}),
      // The key rides along in `id`-independent form; see remoteFromInfo.
      ...({ key: info.key } as object),
    } as PeerInfo);
  }

  private remoteFromInfo(info: PeerInfo): Peer {
    const key = (info as PeerInfo & { key?: string }).key ?? `fed:${info.host}:${info.id}`;
    const host = info.host ?? LOCAL_HOST;
    return {
      ...info,
      key,
      conn: new FedConn(
        this.env,
        { host, ...(info.peerHousehold ? { householdId: info.peerHousehold } : {}) },
        info.leg,
        info.loungeRelay === true || info.transferred === true || info.line === true,
        info.line === true,
      ),
    };
  }

  /** Calls someone `as` is connected with in another household or on another server. */
  private async connectionDial(
    caller: Peer,
    connectionId: string,
    as: { id: string; label: string } = caller,
    opts: { addonShare?: { id: string; label: string; grantId?: string } } = {},
  ): Promise<void> {
    const { store } = this.env;
    const user = await store.getUser(as.id);
    const conn = await store.connections.get(connectionId);
    if (
      !user ||
      conn?.accountId !== user.accountId ||
      conn.state !== "active" ||
      !conn.peerAccount
    ) {
      caller.conn.send({ t: "error", code: "not_found", message: "no such connection" });
      return;
    }
    let peerHousehold: string | undefined;
    if (conn.peerHost === LOCAL_HOST) {
      // In this household too: an ordinary call between members.
      const here = await store.membership(conn.peerAccount, this.householdId);
      if (here) return this.userDial(caller, here.id, as, opts);
      peerHousehold = (await primaryHousehold(this.env, conn.peerAccount))?.household.id;
      if (!peerHousehold) return this.refuse(caller, "unreachable");
    }
    const account = (await store.getAccount(user.accountId)) as Account;
    const label = (conn.peerName || conn.peerHandle).slice(0, 24);
    return this.dialRemote(caller, {
      as,
      host: conn.peerHost,
      key: `fed:${conn.peerHost}:${conn.peerAccount}`,
      label,
      peerHousehold,
      body: {
        from: partyOf(account),
        to: { kind: "person", handle: conn.peerHandle },
      },
      vmTarget: { kind: "connection", connectionId: conn.id, name: label },
      ...opts,
    });
  }

  /** Calls a phone in another household or on another server that a connection shared. */
  private async connectionPhoneDial(caller: Peer, connectionId: string, deviceId: string) {
    const { store } = this.env;
    const user = await store.getUser(caller.id);
    const conn = await store.connections.get(connectionId);
    const phone = conn
      ? (await store.connectionPhones(conn.id)).find((p) => p.deviceId === deviceId)
      : undefined;
    if (!user || conn?.accountId !== user.accountId || conn.state !== "active" || !phone) {
      caller.conn.send({ t: "error", code: "not_found", message: "no such phone" });
      return;
    }
    let peerHousehold: string | undefined;
    if (conn.peerHost === LOCAL_HOST) {
      peerHousehold = (await store.getDevice(deviceId))?.householdId;
      if (!peerHousehold || peerHousehold === this.householdId)
        return this.refuse(caller, "denied");
    }
    const account = (await store.getAccount(user.accountId)) as Account;
    return this.dialRemote(caller, {
      host: conn.peerHost,
      key: `fed:${conn.peerHost}:phone:${deviceId}`,
      label: phone.label,
      peerHousehold,
      kidsPhone: true,
      body: { from: partyOf(account), to: { kind: "phone", deviceId } },
      vmTarget: { kind: "connection", connectionId: conn.id, deviceId, name: phone.label },
    });
  }

  /** A household phone calls a connection on its allow-list, through its guardian's connection. */
  private async remoteContactDial(device: DevicePeer, contactId: string): Promise<void> {
    const { store } = this.env;
    const entry = (await store.listRemoteContacts(device.id)).find((r) => r.id === contactId);
    const conn = entry?.connection;
    if (!entry || !conn?.peerAccount) return this.refuse(device, "denied");
    let peerHousehold: string | undefined;
    if (conn.peerHost === LOCAL_HOST) {
      peerHousehold = (await primaryHousehold(this.env, conn.peerAccount))?.household.id;
      if (!peerHousehold || peerHousehold === this.householdId)
        return this.refuse(device, "denied");
    }
    const guardian = await store.getAccount(conn.accountId);
    if (!guardian) return this.refuse(device, "denied");
    return this.dialRemote(device, {
      host: conn.peerHost,
      key: `fed:${conn.peerHost}:${conn.peerAccount}`,
      label: entry.label,
      peerHousehold,
      body: {
        from: partyOf(guardian),
        to: { kind: "person", handle: conn.peerHandle },
        viaPhone: { label: device.label.slice(0, 24) },
      },
      vmTarget: {
        kind: "connection",
        connectionId: conn.id,
        viaPhone: device.label.slice(0, 24),
        name: entry.label,
      },
      vmCheck: { deviceId: device.id, userId: contactId, field: "deviceCanCall" },
    });
  }

  private async dialRemote(
    caller: Peer,
    target: {
      host: string;
      key: string;
      label: string;
      peerHousehold: string | undefined;
      body: Omit<CallBody, "callId">;
      /** The person calling, when `caller` is a phone they're using. */
      as?: { id: string; label: string };
      /** Voicemail if it goes unanswered, through the same connection. */
      vmTarget?: VmTarget;
      vmCheck?: VmCaller["check"];
      /** Calling a kids' phone elsewhere: never recorded. */
      kidsPhone?: boolean;
      /** Calling a public line: its queue updates and voicemail offer come through. */
      line?: boolean;
      /** This call's id (chosen ahead, e.g. a call back's transfer notice names it). */
      callId?: string;
      /** Calling an add-on: its name and address (the far end is labelled as one). */
      addon?: { name: string; address: string };
      /** Our add-on calls within one of its shares (the far end shows its label). */
      addonShare?: { id: string; label: string; grantId?: string };
      /**
       * Not metered here: an add-on's calls count against its owner, on the add-on's side (a
       * call to an add-on in another household on this server).
       */
      free?: boolean;
    },
  ): Promise<void> {
    const calls = this.env.calls;
    const from = target.vmTarget
      ? await this.vmCaller(caller, target.as?.label ?? caller.label, target.as)
      : undefined;
    const vm =
      from && target.vmTarget
        ? {
            target: target.vmTarget,
            from: target.vmCheck ? { ...from, check: target.vmCheck } : from,
          }
        : undefined;
    if (!calls) return this.refuse(caller, "unreachable");
    if (!this.canDial(caller)) return this.refuse(caller, "busy", CALLER_BUSY_NOTE);
    // An add-on's own server says when it's busy (it may take several calls at once).
    if (!target.addon && this.busy(target.key)) return this.refuse(caller, "busy", undefined, vm);
    const allowance = target.free
      ? { payer: undefined, note: undefined }
      : await this.allowance(caller, target.as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);
    const to = target.body.to;
    // An add-on calls people only, and says so (the far side labels it).
    const fromAddon = caller.kind === "addon" ? caller.addon?.name : undefined;
    if (caller.kind === "addon" && (to.kind !== "person" || !fromAddon)) {
      return this.refuse(caller, "unavailable");
    }
    if (target.addonShare && !fromAddon) return this.refuse(caller, "unavailable");
    const host = target.host || ownHost(this.env);
    const { line: _line, callId: _id, free: _free, addonShare, ...peerInfo } = target;
    const remote = this.remotePeer({
      ...peerInfo,
      address:
        to.kind === "person" || to.kind === "line"
          ? `${to.handle}@${host}`
          : to.kind === "addon"
            ? `${to.handle}+${to.name}@${host}`
            : `device:${to.deviceId}@${host}`,
    });
    // The far end decides when it stops ringing (its own ring time); this is only a backstop.
    const room = this.openRoom(
      caller,
      remote.key,
      target.callId ?? newId("call"),
      MAX_RING_SECONDS * 1000 + 5_000,
    );
    room.payer = allowance.payer;
    room.calleePeer = remote;
    if (vm) room.vm = vm;
    if (target.kidsPhone) room.noRecording = true;
    if (target.line) room.farLine = true;
    if (addonShare) room.addonShare = addonShare;
    this.roomsDirty = true;
    await calls.register(target.host, room.id, this.householdId);
    caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    // The far server is told up front if this space will record (it may refuse such calls).
    const recording = !target.kidsPhone && (await this.recordingBy([caller, remote])) !== undefined;
    // Placement goes over the network: not inside the hub's queue.
    const body: CallBody = {
      ...target.body,
      callId: room.id,
      ...(recording ? { recording: true } : {}),
      ...(fromAddon ? { addon: fromAddon } : {}),
      ...(fromAddon && addonShare
        ? { addonShare: { id: addonShare.id, label: addonShare.label } }
        : {}),
    };
    void calls.place(target.host, body, this.householdId).then(
      (r) =>
        r.state === "ended"
          ? this.run(async () => {
              if (r.note) room.endNote = r.note;
              // A public line offers its own box: our caller gets an offer that forwards there.
              if (r.voicemail && room.farLine)
                await this.relayOffer(room, target.host, r.voicemail);
              return this.apply(room, { type: "end", reason: r.reason });
            })
          : undefined,
      (e) => {
        this.env.log("warn", "federated call placement failed", { error: String(e) });
        return this.run(() => this.apply(room, { type: "end", reason: "unreachable" }));
      },
    );
  }

  /**
   * Rings someone here for a caller in another household or on another server. The caller's
   * side already checked its own rules; this side decides with its own (connection checked by
   * `FedCalls.receive`; here: availability, busy, and for phones the allow-list and quiet hours).
   */
  remoteRing(req: RemoteRing): Promise<RingResult> {
    return this.run(async (): Promise<RingResult> => {
      const { store } = this.env;
      const end = (
        reason: "denied" | "voicemail" | "busy" | "unreachable" | "unavailable" | "error",
      ) => ({ state: "ended", reason }) as const;
      if (this.rooms.has(req.callId)) return end("error");
      if (this.busy(req.key)) return end("busy");
      const remote = this.remotePeer({
        host: req.host,
        key: req.key,
        label: req.label,
        peerHousehold: req.peerHousehold,
        ...(req.address ? { address: req.address } : {}),
        ...(req.fromKidsPhone ? { kidsPhone: true } : {}),
        ...(req.addon ? { addon: req.addon } : {}),
      });
      if (req.target.kind === "addon") {
        return this.ringAddon(remote, req.callId, req.target, req.label, req.address ?? "");
      }
      if (req.target.kind === "person") {
        const userId = req.target.userId;
        const targets = this.reachable(userId);
        const plans = req.noBranches ? [] : await this.branchesFor(userId);
        if (!targets.length && !plans.length) return end("unreachable");
        const available = (await store.availability(this.householdId)).get(userId) ?? true;
        if (!available) return end("unavailable");
        const waiting = this.busy(userKey(userId)) ? await this.waitingRing(userKey(userId)) : [];
        if (this.busy(userKey(userId)) && !waiting.length) return end("busy");
        const room = this.openRoom(
          remote,
          userKey(userId),
          req.callId,
          await this.personRingMs(userId),
        );
        if (req.noBranches) room.branchLeg = true;
        if (waiting.length) this.ringWaiting(room, waiting, req.label);
        else this.ringAll(room, targets, plans, req.label);
        return { state: "ringing" };
      }
      if (req.target.kind === "line") {
        return this.lineRing(req.target.groupId, {
          host: req.host,
          key: req.key,
          label: req.label,
          peerHousehold: req.peerHousehold,
          callId: req.callId,
          address: req.address ?? "",
          ...(req.from ? { from: req.from } : {}),
          ...(req.target.callbackSince !== undefined
            ? { callbackSince: req.target.callbackSince }
            : {}),
        });
      }
      if (req.target.kind === "guest") {
        // Ring our Lounge phone where the calling server's account is a guest right now.
        const peer = this.devices.get(req.target.deviceId);
        const guest = peer?.lounge?.session?.guest;
        if (!peer || guest?.host !== req.host || guest.id !== req.target.guestId) {
          return end("unreachable");
        }
        if (this.busy(peer.key) || peer.hook === "up") return end("busy");
        const room = this.openRoom(remote, peer.key, req.callId);
        room.calleePeer = peer;
        this.roomsDirty = true;
        peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: req.label } });
        return { state: "ringing" };
      }
      const device = await store.getDevice(req.target.deviceId);
      if (!device || device.householdId !== this.householdId) return end("denied");
      const [contact, schedule] = await Promise.all([
        store.getContact(device.id, req.target.contactId),
        device.ownerUserId
          ? store.getSchedule(this.householdId).then((q) => ({ ...q, rules: [] }))
          : store.getSchedule(this.householdId),
      ]);
      const decision = authorizeInbound(contact, {
        quietHours: schedule,
        now: new Date(this.env.now()),
      });
      if (decision.decision === "deny" || !contact) return end("denied");
      if (decision.decision === "voicemail") return end("voicemail");
      const peer = this.devices.get(device.id);
      if (!peer) return end("unreachable");
      const waiting = this.busy(peer.key) ? (await this.waitingRing(peer.key)).length > 0 : false;
      if ((this.busy(peer.key) || peer.hook === "up") && !waiting) return end("busy");
      const room = this.openRoom(
        remote,
        peer.key,
        req.callId,
        await this.ringMs({ deviceId: device.id }),
      );
      room.calleePeer = peer;
      this.roomsDirty = true;
      peer.conn.send({
        t: "call.ringing",
        callId: room.id,
        from: { label: contact.label },
        ...(waiting ? { waiting: true as const } : {}),
      });
      return { state: "ringing" };
    });
  }

  /** Signaling from the far end of a call with another household (host '') or server. */
  remoteSignal(host: string, msg: FedSignal): Promise<void> {
    return this.run(async () => {
      if (msg.t === "room.signal") {
        // For one of our people in a room held there, or from someone there in a room held here.
        const leg = this.legs.get(msg.callId);
        if (leg && leg.conn.to.host === host) return this.legSignal(leg, msg.msg);
        const here = this.conf.findRemote(host, msg.callId);
        if (here && isRoomInbound(msg.msg)) return this.conf.message(here.room, here.p, msg.msg);
        return;
      }
      let room: Room | undefined;
      let remote: Peer | undefined;
      for (const r of this.rooms.values()) {
        remote = [r.caller, r.calleePeer, ...(r.branches ?? [])].find(
          (p) => p?.kind === "remote" && p.host === host && (p.leg ?? r.id) === msg.callId,
        );
        if (remote) {
          room = r;
          break;
        }
      }
      if (!room || !remote) {
        // Their server refused to follow a transfer (e.g. a kids' phone): end its successor.
        const key = `${host}|${msg.callId}`;
        const next = this.rooms.get(this.handoffs.get(key) ?? "");
        this.handoffs.delete(key);
        if (next && msg.t === "call.state" && msg.state === "ended") {
          await this.apply(next, { type: "end", reason: msg.reason ?? "hangup" });
        }
        return;
      }
      if (msg.t === "call.voicemail") {
        // Their caller would rather leave a message than wait in our line.
        return remote === room.caller ? this.lineVoicemail(remote, room.id) : undefined;
      }
      if (msg.t === "call.callback") {
        // Their caller would rather be called back than wait in our line.
        return remote === room.caller ? this.lineCallback(remote, room.id) : undefined;
      }
      if (room.branches?.includes(remote)) {
        // One of the places ringing for the callee elsewhere.
        if (msg.t !== "call.state") return;
        if (msg.state === "ended") return this.dropBranch(room, remote, msg.reason ?? "hangup");
        if (msg.state !== "connecting" || room.state.phase !== "ringing") return;
        for (const other of this.ringTargets(room)) {
          if (other !== remote) {
            other.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
          }
        }
        room.branches = [];
        room.calleePeer = remote;
        this.roomsDirty = true;
        return this.apply(room, { type: "answer", by: room.state.callee });
      }
      const party = remote === room.caller ? "caller" : "callee";
      if (msg.t === "call.state" && msg.state === "ringing") {
        // A public line elsewhere: its name, and our caller's place in its queue.
        if (party !== "callee" || !room.farLine || room.state.phase !== "ringing") return;
        if (msg.line) {
          remote.label = msg.line.name.slice(0, 24);
          this.roomsDirty = true;
        }
        room.caller.conn.send({ ...msg, callId: room.id });
        return;
      }
      if (msg.t === "call.state") {
        if (msg.state === "ended" && msg.merged) {
          return this.convertToLeg(room, remote, msg.merged.roomId);
        }
        if (msg.state === "ended" && msg.transfer) return this.repoint(room, remote, msg.transfer);
        if (msg.state === "active" && msg.recording) {
          return this.farRecording(room, remote, party, msg.recording.by);
        }
        if (
          msg.state === "active" &&
          room.state.phase === "active" &&
          (msg.hold !== undefined || room.heldBy === remote.key)
        ) {
          // They put the call on hold (or took it back): tell our side, as it is.
          room.heldBy = msg.hold === "them" ? remote.key : undefined;
          this.roomsDirty = true;
          const other = party === "caller" ? room.calleePeer : room.caller;
          other?.conn.send({ ...msg, callId: room.id });
          return;
        }
        if (msg.state === "ended") {
          if (msg.note) room.endNote = msg.note;
          if (msg.callback && party === "callee" && room.farLine) {
            room.callbackUntil = msg.callback.until;
          }
          if (msg.voicemail && party === "callee") await this.relayOffer(room, host, msg.voicemail);
          return this.apply(room, { type: "end", reason: msg.reason ?? "hangup" });
        }
        if (msg.state === "connecting" && party === "callee") {
          return this.apply(room, { type: "answer", by: room.state.callee });
        }
        return;
      }
      if (room.state.phase !== "connecting" && room.state.phase !== "active") return;
      const other = party === "caller" ? room.calleePeer : room.caller;
      if (!other) return;
      // Keys pressed in a call reach an add-on only.
      if (msg.t === "call.key" && (other.kind !== "addon" || room.state.phase !== "active")) return;
      other.conn.send({ ...msg, callId: room.id });
      if (msg.t === "rtc.sdp" && msg.type === "answer")
        await this.apply(room, { type: "connected" });
    });
  }

  // --- guests from other servers at our Lounge phones -------------------------------------

  /**
   * Someone's home server vouches that they scanned this Lounge phone's code. Same rules as a
   * member's claim (single-use code, then the key proof at the phone), if this space lets guests
   * in at all.
   */
  guestClaim(
    deviceId: string,
    nonce: string,
    guest: LoungeGuest,
  ): Promise<{ step: "press_key"; expiresAt: number } | { step: "failed"; reason: LoungeFail }> {
    return this.run(async () => {
      const failed = (reason: LoungeFail) => ({ step: "failed" as const, reason });
      const device = this.devices.get(deviceId);
      const lounge = device?.lounge;
      if (!device || !lounge || !(await this.env.store.loungeGuests(this.householdId))) {
        return failed("not_found");
      }
      if (this.env.now() >= lounge.nonceExpiresAt || nonce !== lounge.nonce) {
        if (!lounge.challenge && this.env.now() >= lounge.nonceExpiresAt) this.issueNonce(device);
        return failed("expired");
      }
      this.issueNonce(device);
      if (this.busy(device.key)) return failed("busy");
      if (lounge.challenge) this.notifyClaimant(device, lounge.challenge, "failed", "timeout");
      const expiresAt = this.env.now() + LOUNGE_PROOF_MS;
      lounge.challenge = {
        userId: guestKey(guest),
        name: guest.name.slice(0, 24),
        index: randomKey(),
        expiresAt,
        app: "",
        guest,
      };
      this.remember(device);
      device.conn.send({ t: "lounge.challenge", index: lounge.challenge.index, expiresAt });
      this.armProof(device, LOUNGE_PROOF_MS);
      return { step: "press_key" as const, expiresAt };
    });
  }

  /** A guest left from their own app (through their server). */
  guestLeave(deviceId: string, host: string, guestId: string): Promise<void> {
    return this.run(async () => {
      const device = this.devices.get(deviceId);
      const session = device?.lounge?.session;
      if (device && session?.guest?.host === host && session.guest.id === guestId) {
        await this.endLoungeSession(device, "left");
      }
    });
  }

  /** Tells whoever scanned the code how their claim went (their app, or their server). */
  private notifyClaimant(
    device: DevicePeer,
    challenge: NonNullable<LoungeInfo["challenge"]>,
    step: "failed",
    reason: LoungeFail,
  ): void {
    if (challenge.guest) {
      this.notifyGuest(challenge.guest, device.id, { step, reason });
      return;
    }
    this.appSession(challenge.app)?.conn.send({
      t: "lounge.progress",
      deviceId: device.id,
      step,
      reason,
    });
  }

  private notifyGuest(
    guest: LoungeGuest,
    deviceId: string,
    body: { step: "press_key" | "started" | "failed" | "ended"; reason?: string },
  ): void {
    this.env.defer(
      sendGuestProgress(this.env, guest.host, { to: guest.handle, deviceId, ...body }),
    );
  }

  private async startGuestSession(device: DevicePeer, guest: LoungeGuest): Promise<void> {
    const lounge = device.lounge;
    if (!lounge) return;
    if (lounge.session) await this.endLoungeSession(device, "replaced");
    const key = guestKey(guest);
    for (const other of this.devices.values()) {
      if (other.lounge?.session?.userId === key) await this.endLoungeSession(other, "replaced");
    }
    const now = this.env.now();
    const name = guest.name.slice(0, 24);
    const id = await this.env.store.startLoungeSession(
      {
        householdId: this.householdId,
        deviceId: device.id,
        guest: { address: `${guest.handle}@${guest.host}`, name },
      },
      now,
    );
    lounge.session = { id, userId: key, name, since: now, openToChat: false, guest };
    this.remember(device);
    device.conn.send({ t: "lounge.session", name, openToChat: false });
    await this.sendConfig(device, true);
    this.notifyGuest(guest, device.id, { step: "started" });
    this.broadcastStatus(device, true);
    await this.touchIdle(device);
    await this.scheduleWake();
  }

  /** A guest's key: dialed through their own server, with this phone as the far end. */
  private async guestDial(device: DevicePeer, guest: LoungeGuest, entry: LoungeEntry) {
    const calls = this.env.calls;
    if (!calls) return this.refuse(device, "unreachable");
    const remote = this.remotePeer({
      host: guest.host,
      // Not the guest's person key: they may be called back here in the same breath.
      key: `fed:${guest.host}:via-lounge:${device.id}`,
      label: entry.label,
      address: entry.id,
    });
    // The guest's server (and the callee's) decide when it stops ringing; this is a backstop.
    const room = this.openRoom(device, remote.key, undefined, MAX_RING_SECONDS * 1000 + 5_000);
    room.calleePeer = remote;
    this.roomsDirty = true;
    await calls.register(guest.host, room.id, this.householdId);
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    const body = {
      callId: room.id,
      for: guest.handle,
      deviceId: device.id,
      deviceLabel: device.label.slice(0, 24),
      to: entry.id,
    };
    void placeGuestDial(this.env, guest.host, body).then((r) =>
      r.state === "ended"
        ? this.run(async () => {
            if (r.voicemail) await this.relayOffer(room, guest.host, r.voicemail);
            return this.apply(room, { type: "end", reason: r.reason });
          })
        : undefined,
    );
  }

  /**
   * The other server offered voicemail for a call it answers for: a guest's call from our Lounge
   * phone (their own server offers, as them), or our person's call that a team/org space there
   * transferred and nobody picked up (its box, as for a caller of its own). The caller gets an
   * offer of ours that forwards greeting and message to theirs (`relay`). Only then: any other
   * call's voicemail is ours to offer, through the connection.
   */
  private async relayOffer(room: Room, host: string, offer: VoicemailOffer): Promise<void> {
    const caller = room.caller;
    const far = room.calleePeer;
    if (far?.host !== host) return;
    const guest = caller.kind === "device" ? caller.lounge?.session?.guest : undefined;
    let from: VmCaller | undefined;
    if (guest) {
      if (guest.host !== host) return;
      from = { label: guest.name.slice(0, 24), address: `device:${caller.id}` };
    } else if ((far.transferred || room.farLine) && !room.vm && caller.kind !== "remote") {
      from = await this.vmCaller(caller, caller.label);
    }
    if (!from) return;
    room.vm = { target: { kind: "relay", host, ticket: offer.ticket, name: offer.name }, from };
    this.roomsDirty = true;
  }

  /**
   * One of our accounts, as a guest at another server's Lounge phone, dials someone they're
   * connected with. This server places the call as them (its rules, its connection) and relays
   * between the two legs: the Lounge phone's server, and the person called.
   */
  relayDial(req: RelayDial): Promise<RingResult> {
    return this.run(async (): Promise<RingResult> => {
      const { store } = this.env;
      const calls = this.env.calls;
      const conn = await store.connections.get(req.connectionId);
      if (!calls || conn?.state !== "active" || !conn.peerAccount) {
        return { state: "ended", reason: "denied" };
      }
      const caller = this.remotePeer({
        host: req.host,
        key: `fed:${req.host}:lounge:${req.deviceId}`,
        label: req.deviceLabel,
        leg: req.callId,
        address: `device:${req.deviceId}@${req.host}`,
        loungeRelay: true,
      });
      if (this.busy(caller.key)) return { state: "ended", reason: "busy" };
      const account = (await store.getAccount(conn.accountId)) as Account;
      if (await fairUseProblem(this.env, account.id, "call")) {
        return { state: "ended", reason: "denied" };
      }
      // Voicemail if it goes unanswered: left as this account, offered to the Lounge phone.
      const self = (await primaryHousehold(this.env, account.id))?.user;
      const from: VmCaller = {
        ...(self ? { userId: self.id } : {}),
        payer: account.id,
        label: account.name.slice(0, 24),
        address: caller.address as string,
      };
      const here =
        conn.peerHost === LOCAL_HOST
          ? await store.membership(conn.peerAccount, this.householdId)
          : undefined;
      const vm: NonNullable<Room["vm"]> = {
        target: here
          ? { kind: "user", userId: here.id, name: here.name }
          : {
              kind: "connection",
              connectionId: conn.id,
              name: (conn.peerName || conn.peerHandle).slice(0, 24),
            },
        from,
      };
      const refuse = async (reason: "busy" | "unreachable"): Promise<RingResult> => {
        const voicemail = await this.offer(vm, reason, this.env.now());
        return { state: "ended", reason, ...(voicemail ? { voicemail } : {}) };
      };
      let peerHousehold: string | undefined;
      if (conn.peerHost === LOCAL_HOST) {
        if (here) {
          // Someone in this household: ring them here (and wherever else they are).
          const targets = this.reachable(here.id);
          const plans = await this.branchesFor(here.id);
          if (!targets.length && !plans.length) return refuse("unreachable");
          if (this.busy(userKey(here.id))) return refuse("busy");
          const room = this.openRoom(
            caller,
            userKey(here.id),
            undefined,
            await this.personRingMs(here.id),
          );
          room.payer = account.id;
          room.vm = vm;
          await calls.register(req.host, req.callId, this.householdId);
          this.ringAll(room, targets, plans, account.name.slice(0, 24));
          return { state: "ringing" };
        }
        peerHousehold = (await primaryHousehold(this.env, conn.peerAccount))?.household.id;
        if (!peerHousehold) return { state: "ended", reason: "unreachable" };
      }
      const leg = newId("call");
      const callee = this.remotePeer({
        host: conn.peerHost,
        key: `fed:${conn.peerHost}:${conn.peerAccount}`,
        label: (conn.peerName || conn.peerHandle).slice(0, 24),
        peerHousehold,
        leg,
        address: `${conn.peerHandle}@${conn.peerHost || ownHost(this.env)}`,
      });
      if (this.busy(callee.key)) return refuse("busy");
      const room = this.openRoom(caller, callee.key, undefined, MAX_RING_SECONDS * 1000 + 5_000);
      room.payer = account.id;
      room.calleePeer = callee;
      room.vm = vm;
      this.roomsDirty = true;
      await calls.register(req.host, req.callId, this.householdId);
      await calls.register(conn.peerHost, leg, this.householdId);
      const body: CallBody = {
        callId: leg,
        from: partyOf(account),
        to: { kind: "person", handle: conn.peerHandle },
        guestOf: req.host,
      };
      void calls
        .place(conn.peerHost, body, this.householdId)
        .then((r) =>
          r.state === "ended"
            ? this.run(() => this.apply(room, { type: "end", reason: r.reason }))
            : undefined,
        );
      return { state: "ringing" };
    });
  }

  // --- team and org spaces: extensions and ring groups (docs/workplace.md) ------------------

  /** Whether this space is a workplace (team or org) with extensions. */
  private async isWorkplace(): Promise<boolean> {
    const space = await this.env.store.getHousehold(this.householdId);
    return !!space && space.type !== "home";
  }

  /**
   * Who is calling: the person at an app, or the person a phone stands for (its owner, or a
   * member signed in at a Lounge phone). Nobody for kids' phones, idle Lounge phones and guests.
   */
  private async callingAs(peer: Peer): Promise<{ id: string; label: string } | undefined> {
    if (peer.kind === "user") return { id: peer.id, label: peer.label };
    if (peer.kind !== "device") return undefined;
    const d = peer as DevicePeer;
    if (d.lounge) {
      const s = d.lounge.session;
      return s && !s.guest ? { id: s.userId, label: s.name } : undefined;
    }
    if (!d.owner) return undefined;
    const user = await this.env.store.getUser(d.owner);
    return user ? { id: user.id, label: user.name } : undefined;
  }

  /** Team/org spaces: an extension dialed from an app or a phone of this space. */
  private async extensionDial(peer: Peer, number: string): Promise<void> {
    const { store } = this.env;
    const ext = (await this.isWorkplace())
      ? await store.workplace.extension(this.householdId, number)
      : undefined;
    if (!ext) return this.refuse(peer, "denied", NO_EXTENSION);
    const as = await this.callingAs(peer);
    if (!as) return this.refuse(peer, "denied");
    if (ext.kind === "user") return this.userDial(peer, ext.targetId, as);
    if (ext.kind === "room") {
      const stored = await store.rooms.get(ext.targetId);
      if (!stored || stored.householdId !== this.householdId) {
        return this.refuseRoom(peer, "denied", undefined, NO_EXTENSION);
      }
      return this.joinLocal(peer, stored);
    }
    return this.placeInSpace(
      peer,
      as,
      ext.kind === "device" ? { deviceId: ext.targetId } : { groupId: ext.targetId },
    );
  }

  /**
   * A call from someone here (`as`) to a phone or a ring group of this space: the fair-use
   * check, then ring it; refused calls get a voicemail offer where one applies.
   */
  private async placeInSpace(
    caller: Peer,
    as: { id: string; label: string },
    target: { deviceId: string } | { groupId: string },
  ): Promise<void> {
    if (!this.canDial(caller)) return this.refuse(caller, "busy", CALLER_BUSY_NOTE);
    const allowance = await this.allowance(caller, as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);
    const opened =
      "deviceId" in target
        ? await this.openToPhone(caller, target.deviceId, as.label)
        : await this.openToGroup(caller, target.groupId, as.label, { except: as.id });
    const from = await this.vmCaller(caller, as.label, as);
    if (!("state" in opened)) {
      const vm = from && opened.vm ? { target: opened.vm, from } : undefined;
      return this.refuse(caller, opened.reason, opened.note, vm);
    }
    opened.payer = allowance.payer;
    const vmTarget = await this.vmTargetOf(opened);
    if (from && vmTarget) opened.vm = { target: vmTarget, from };
    this.roomsDirty = true;
    caller.conn.send({ t: "call.state", callId: opened.id, state: "ringing" });
  }

  /** Where an unanswered call in this space leaves its message: a group's box or a person. */
  private async vmTargetOf(room: Room): Promise<VmTarget | undefined> {
    if (room.hunt) return { kind: "group", groupId: room.hunt.groupId, name: room.hunt.name };
    const key = room.state.callee;
    if (key.startsWith("usr:")) {
      const user = await this.env.store.getUser(idOf(key));
      return user && { kind: "user", userId: user.id, name: user.name };
    }
    const owner = room.calleePeer?.kind === "device" ? room.calleePeer.owner : undefined;
    const user = owner ? await this.env.store.getUser(owner) : undefined;
    return user && { kind: "user", userId: user.id, name: room.calleePeer?.label ?? user.name };
  }

  /** Rings a member of this space for `caller` (someone here, or a transferred remote party). */
  private async openToUser(
    caller: Peer,
    userId: string,
    label: string,
    id?: string,
  ): Promise<Room | Refusal> {
    const user = await this.env.store.getUser(userId);
    if (!user || user.householdId !== this.householdId) return { reason: "denied" };
    const vm: VmTarget = { kind: "user", userId, name: user.name };
    const targets = this.reachable(userId, caller);
    const plans = await this.branchesFor(userId);
    if (!targets.length && !plans.length) return { reason: "unreachable", vm };
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    if (!available) return { reason: "unavailable", vm };
    if (this.busy(userKey(userId))) return { reason: "busy", vm };
    const room = this.openRoom(caller, userKey(userId), id, await this.personRingMs(userId));
    this.ringAll(room, targets, plans, label);
    return room;
  }

  /** Rings a personal (desk) phone or a Lounge phone of this space. */
  private async openToPhone(
    caller: Peer,
    deviceId: string,
    label: string,
    id?: string,
  ): Promise<Room | Refusal> {
    const { store } = this.env;
    const target = await store.getDevice(deviceId);
    const mode = target && deviceMode(target);
    if (!target || target.householdId !== this.householdId || mode === "kids" || mode === "left") {
      return { reason: "denied" };
    }
    const peer = this.devices.get(deviceId);
    const owner = target.ownerUserId ? await store.getUser(target.ownerUserId) : undefined;
    const vm: VmTarget | undefined = owner && {
      kind: "user",
      userId: owner.id,
      name: target.name,
    };
    if (owner && !((await store.availability(this.householdId)).get(owner.id) ?? true)) {
      return { reason: "unavailable", ...(vm ? { vm } : {}) };
    }
    const session = peer?.lounge?.session;
    if (!peer || (peer.lounge && !session)) return { reason: "unreachable", ...(vm ? { vm } : {}) };
    if (peer === caller || this.busy(peer.key) || peer.hook === "up") {
      return { reason: "busy", ...(vm ? { vm } : {}) };
    }
    const room = this.openRoom(
      caller,
      peer.key,
      id,
      await this.ringMs(owner ? { accountId: owner.accountId } : undefined),
    );
    room.calleePeer = peer;
    this.roomsDirty = true;
    peer.conn.send({ t: "call.ringing", callId: room.id, from: { label } });
    return room;
  }

  /**
   * Rings a ring group: its business hours first (closed → its after-hours action: its shared
   * voicemail box, or another group or a member, forwarding once at most), then its steps
   * (all at once, one by one, or round robin). `except`: the caller, if a member.
   */
  private async openToGroup(
    caller: Peer,
    groupId: string,
    label: string,
    opts: {
      except?: string;
      forwarded?: boolean;
      id?: string;
      /**
       * A call to the group's public line: it may wait in the line's queue. `since`: calling
       * back in after a call back (their place); `callback`: who to call back if they ask.
       */
      line?: {
        line: PublicLine;
        address: string;
        name: string;
        since?: number;
        callback?: LineCallState["callback"];
      };
    },
  ): Promise<Room | Refusal> {
    const { store } = this.env;
    const group = await store.workplace.group(groupId);
    const space = await store.getHousehold(this.householdId);
    if (!group || !space || group.householdId !== this.householdId) {
      return { reason: "denied", note: NO_EXTENSION };
    }
    const box: VmTarget = { kind: "group", groupId: group.id, name: group.name };
    const spaceHours = await store.workplace.spaceHours(this.householdId);
    const hours = effectiveHours(space.timeZone, group.hours, spaceHours.hours);
    if (!isOpen(hours, new Date(this.env.now()))) {
      const action = afterHoursAction(
        group.afterHours,
        spaceHours.afterHours,
        !!opts.forwarded,
        group.id,
      );
      if (action.kind === "group") {
        // A forwarded call follows that group's own ringing (it never waits in a line).
        const { line: _l, ...rest } = opts;
        return this.openToGroup(caller, action.groupId, label, { ...rest, forwarded: true });
      }
      if (action.kind === "user" && action.userId !== opts.except) {
        const r = await this.openToUser(caller, action.userId, label, opts.id);
        return "state" in r ? r : { ...r, note: CLOSED_NOTE };
      }
      return { reason: "voicemail", note: CLOSED_NOTE, vm: box };
    }
    const line = opts.line;
    // Callers already waiting in the line (or for a call back) go first: a new one joins at the
    // end; someone calling back in after a call back has their place.
    const waiting = line ? await this.queueOf(group.id) : [];
    const ahead =
      line?.since !== undefined ? waiting.filter((e) => e.since < (line.since ?? 0)) : waiting;
    const steps = ahead.length ? [] : await this.huntFor(group, caller, opts.except);
    const first = steps[0];
    const stepMs = group.ringSeconds * 1000;
    const now = this.env.now();
    // Places in line are strictly ordered, even for callers in the same millisecond.
    const since = line?.since ?? (await this.nextPlace());
    const lineState = (w: boolean): LineCallState | undefined =>
      line && {
        groupId: group.id,
        info: lineInfo(this.env, line.line, group),
        address: line.address,
        name: line.name,
        since,
        waiting: w,
        waitUntil: now + line.line.queueWaitSeconds * 1000,
        ...(line.callback ? { callback: line.callback } : {}),
      };
    if (!first) {
      if (!line) return { reason: "unavailable", vm: box };
      // Someone calling back in keeps their place even in a full line.
      const admit = line.since !== undefined ? "queue" : queueAdmit(line.line, waiting.length);
      if (admit === "full") return { reason: "busy", vm: box };
      if (admit === "off") return { reason: "unavailable", vm: box };
      // Nobody free: wait in line (see `pumpLines`), no ringing until someone is.
      const room = this.openRoom(caller, `hg:${group.id}`, opts.id, stepMs);
      room.cancelTimer?.();
      room.cancelTimer = undefined;
      room.hunt = { groupId: group.id, name: group.name, steps: [], step: 0, stepMs, label };
      room.group = [];
      room.line = lineState(true);
      this.armWait(room);
      return room;
    }
    if (group.strategy === "round_robin") {
      await store.workplace.setNextIndex(group.id, nextRoundRobin(group.members, first[0] ?? ""));
    }
    const room = this.openRoom(caller, `hg:${group.id}`, opts.id, stepMs);
    room.hunt = { groupId: group.id, name: group.name, steps, step: 0, stepMs, label };
    room.group = first;
    room.line = lineState(false);
    if (room.line) this.armWait(room);
    this.armHunt(room);
    this.ringAll(
      room,
      first.flatMap((u) => this.reachable(u, caller)),
      [],
      label,
    );
    return room;
  }

  /** Someone already ringing for a ring-group call (a person takes one call at a time). */
  private ringingForGroup(userId: string): boolean {
    for (const r of this.rooms.values()) {
      if (r.hunt && !r.calleePeer && r.group?.includes(userId)) return true;
    }
    return false;
  }

  private armHunt(room: Room): void {
    const stepMs = room.hunt?.stepMs ?? RING_TIMEOUT_MS;
    room.cancelTimer?.();
    room.cancelTimer = this.env.setTimer(() => void this.run(() => this.huntNext(room)), stepMs);
  }

  /**
   * The current step of a ring-group call wasn't answered (its time ran out, or everyone in it
   * declined or went away): stop ringing them and ring the next step with someone to ring. After
   * the last step the call times out, and the caller may leave a message in the group's box.
   */
  private async huntNext(room: Room): Promise<void> {
    const hunt = room.hunt;
    if (this.rooms.get(room.id) !== room || room.calleePeer || !hunt) return;
    if (room.state.phase !== "ringing" || room.line?.waiting) return;
    for (const t of this.ringTargets(room)) {
      t.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
    }
    for (let i = hunt.step + 1; i < hunt.steps.length; i++) {
      const members = (hunt.steps[i] ?? []).filter(
        (u) => !this.busy(userKey(u)) && !this.ringingForGroup(u),
      );
      const targets = members.flatMap((u) => this.reachable(u, room.caller));
      if (!targets.length) continue;
      hunt.step = i;
      room.group = members;
      this.roomsDirty = true;
      this.ringAll(room, targets, [], hunt.label);
      this.armHunt(room);
      return;
    }
    room.group = [];
    this.roomsDirty = true;
    if (room.line && !room.line.done) return this.backInLine(room);
    await this.apply(room, { type: "timeout" });
  }

  /** A ring-group member declined: only they stop ringing; the others (or the next step) go on. */
  private async groupDecline(room: Room, peer: Peer): Promise<void> {
    const person = peer.kind === "user" ? peer.id : personOf(peer);
    if (!person) return;
    for (const t of this.reachable(person, room.caller)) {
      t.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
    }
    room.group = (room.group ?? []).filter((u) => u !== person);
    this.roomsDirty = true;
    if (room.group.length === 0) await this.huntNext(room);
  }

  // --- public lines (docs/workplace.md "Public lines") -------------------------------------

  /** The steps a ring group would ring now (members who are free and reachable). */
  private async huntFor(
    group: Pick<RingGroup, "id" | "strategy" | "members" | "nextIndex">,
    caller: Peer | undefined,
    except?: string,
  ): Promise<string[][]> {
    const availability = await this.env.store.availability(this.householdId);
    return huntSteps(
      group.strategy,
      group.members,
      (u) =>
        u !== except &&
        (availability.get(u) ?? true) &&
        !this.busy(userKey(u)) &&
        !this.ringingForGroup(u) &&
        this.reachable(u, caller).length > 0,
      group.nextIndex,
    );
  }

  /** Calls waiting in a line's queue, first come first served. */
  private waitingFor(groupId: string): Room[] {
    const waiting = [...this.rooms.values()]
      .filter((r) => r.line?.groupId === groupId && r.line.waiting && r.state.phase === "ringing")
      .map((room) => ({ callId: room.id, since: room.line?.since ?? 0, room }));
    return queueOrder(waiting).map((e) => e.room);
  }

  /** A line's whole queue in order: callers on the line and those waiting for a call back. */
  private async queueOf(groupId: string, rows?: LineCallback[]): Promise<QueueSlot[]> {
    const slots: QueueSlot[] = this.waitingFor(groupId).map((room) => ({
      kind: "room",
      callId: room.id,
      since: room.line?.since ?? 0,
      room,
    }));
    const callbacks = rows ?? (this.callbacksPending ? await this.callbackRows() : []);
    for (const row of callbacks) {
      if (row.groupId === groupId)
        slots.push({ kind: "callback", callId: row.id, since: row.since, row });
    }
    return queueOrder(slots);
  }

  /** This space's callers waiting for a call back (none known: no query next time). */
  private async callbackRows(): Promise<LineCallback[]> {
    const rows = await this.env.store.lines.callbacks(this.householdId);
    this.callbacksPending = rows.length > 0;
    return rows;
  }

  /** The next place in line: after everyone already in any line here. */
  private async nextPlace(): Promise<number> {
    let since = this.env.now();
    for (const r of this.rooms.values()) if (r.line) since = Math.max(since, r.line.since + 1);
    if (this.callbacksPending) {
      for (const row of await this.callbackRows()) since = Math.max(since, row.since + 1);
    }
    return since;
  }

  /** Someone may have come free, or a caller left a line: let the queues move (soon). */
  private kickLines(): void {
    if (!this.callbacksPending && ![...this.rooms.values()].some((r) => r.line?.waiting)) return;
    void this.run(() => this.pumpLines());
  }

  /**
   * Rings the line's members for the callers at the front of each queue, as long as there is
   * someone free to ring, then tells everyone still waiting their place. A caller waiting for a
   * call back is called back instead, and holds the front until they call in (or miss it).
   */
  private async pumpLines(): Promise<void> {
    const rows = this.callbacksPending ? await this.expireCallbacks(await this.callbackRows()) : [];
    const groups = new Set<string>();
    for (const r of this.rooms.values()) if (r.line?.waiting) groups.add(r.line.groupId);
    for (const row of rows) groups.add(row.groupId);
    for (const groupId of groups) {
      for (const slot of await this.queueOf(groupId, rows)) {
        if (slot.kind === "callback") {
          if (slot.row.ringingUntil === null) await this.callBack(slot.row);
          break;
        }
        if (!(await this.ringFromLine(slot.room))) break;
      }
      await this.sendQueue(groupId, rows);
    }
    if (rows.length) await this.scheduleWake();
  }

  /** The caller at the front of the line: ring the members who are free now, if any. */
  private async ringFromLine(room: Room): Promise<boolean> {
    const state = room.line;
    const hunt = room.hunt;
    if (!state || !hunt) return false;
    const group = await this.env.store.workplace.group(state.groupId);
    if (!group) return false;
    const except = room.caller.kind === "user" ? room.caller.id : personOf(room.caller);
    const steps = await this.huntFor(group, room.caller, except);
    const first = steps[0];
    if (!first) return false;
    if (group.strategy === "round_robin") {
      await this.env.store.workplace.setNextIndex(
        group.id,
        nextRoundRobin(group.members, first[0] ?? ""),
      );
    }
    state.waiting = false;
    state.sent = undefined;
    room.hunt = { ...hunt, steps, step: 0, stepMs: group.ringSeconds * 1000 };
    room.group = first;
    this.roomsDirty = true;
    // No `queue`: the line is ringing for them again.
    room.caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(
      room,
      first.flatMap((u) => this.reachable(u, room.caller)),
      [],
      hunt.label,
    );
    this.armHunt(room);
    return true;
  }

  /** Tells each caller waiting in a line their place (only when it changed). */
  private async sendQueue(groupId: string, rows?: LineCallback[]): Promise<void> {
    const waiting = this.waitingFor(groupId);
    if (!waiting.length) return;
    const line = await this.env.store.lines.get(groupId);
    // Callers waiting for a call back hold their places too.
    const positions = queuePositions(await this.queueOf(groupId, rows));
    const instead = !!line && mayLeaveVoicemailInstead(line);
    const callBack = !!line && mayOfferCallback(line);
    for (const r of waiting) {
      const state = r.line as LineCallState;
      const place = positions.get(r.id);
      const queue = {
        ...(line?.showPosition !== false && place ? place : {}),
        ...(instead && r.vm ? { voicemail: true } : {}),
        ...(callBack && state.callback ? { callback: true } : {}),
      };
      const key = JSON.stringify(queue);
      if (state.sent === key) continue;
      state.sent = key;
      this.roomsDirty = true;
      r.caller.conn.send({ t: "call.state", callId: r.id, state: "ringing", queue });
    }
  }

  /** The line's longest wait for this caller (re-armed after the host slept). */
  private armWait(room: Room): void {
    const state = room.line;
    if (!state || state.done) return;
    room.cancelWait?.();
    room.cancelWait = this.env.setTimer(
      () => void this.run(() => this.lineWaitOver(room)),
      Math.max(0, state.waitUntil - this.env.now()),
    );
  }

  /** The line rang its members for this caller and nobody answered: back to their place. */
  private async backInLine(room: Room): Promise<void> {
    const state = room.line as LineCallState;
    const line = await this.env.store.lines.get(state.groupId);
    if (!line?.queue) return this.apply(room, { type: "timeout" });
    room.cancelTimer?.();
    room.cancelTimer = undefined;
    state.waiting = true;
    this.roomsDirty = true;
    if (state.expired || this.env.now() >= state.waitUntil) return this.lineWaitOver(room);
    await this.sendQueue(state.groupId);
  }

  /** A caller waited the line's longest wait: voicemail, overflow, or the end, as it says. */
  private async lineWaitOver(room: Room): Promise<void> {
    const state = room.line;
    if (this.rooms.get(room.id) !== room || !state || state.done) return;
    if (room.calleePeer || room.state.phase !== "ringing") return;
    if (!state.waiting) {
      // Members are ringing for them right now: it applies if nobody answers.
      state.expired = true;
      this.roomsDirty = true;
      return;
    }
    const line = await this.env.store.lines.get(state.groupId);
    const action = line ? maxWaitOutcome(line, state.groupId) : { kind: "end" as const };
    state.waiting = false;
    state.done = true;
    room.cancelWait?.();
    this.roomsDirty = true;
    if (action.kind === "voicemail") return this.apply(room, { type: "end", reason: "timeout" });
    if (action.kind === "group") return this.overflowToGroup(room, action.groupId);
    if (action.kind === "user") return this.overflowToUser(room, action.userId);
    room.vm = undefined;
    room.endNote = action.message ?? LINE_ENDED_NOTE;
    return this.apply(room, { type: "end", reason: "unavailable" });
  }

  /** After the longest wait: ring another ring group of the space instead (no queue there). */
  private async overflowToGroup(room: Room, groupId: string): Promise<void> {
    const group = await this.env.store.workplace.group(groupId);
    if (!group || group.householdId !== this.householdId) {
      return this.apply(room, { type: "end", reason: "unavailable" });
    }
    if (room.vm) {
      room.vm = { ...room.vm, target: { kind: "group", groupId: group.id, name: group.name } };
    }
    const steps = await this.huntFor(group, room.caller);
    const first = steps[0];
    if (!first) return this.apply(room, { type: "end", reason: "unavailable" });
    const label = room.hunt?.label ?? room.caller.label;
    const stepMs = group.ringSeconds * 1000;
    room.state = { ...room.state, callee: `hg:${group.id}` };
    room.hunt = { groupId: group.id, name: group.name, steps, step: 0, stepMs, label };
    room.group = first;
    this.roomsDirty = true;
    room.caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(
      room,
      first.flatMap((u) => this.reachable(u, room.caller)),
      [],
      label,
    );
    this.armHunt(room);
  }

  /** After the longest wait: ring one member instead. */
  private async overflowToUser(room: Room, userId: string): Promise<void> {
    const user = await this.env.store.getUser(userId);
    if (user && room.vm) {
      room.vm = { ...room.vm, target: { kind: "user", userId, name: user.name } };
    }
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    const targets = this.reachable(userId, room.caller);
    if (!user || user.householdId !== this.householdId || !available || !targets.length) {
      return this.apply(room, { type: "end", reason: "unavailable" });
    }
    if (this.busy(userKey(userId))) return this.apply(room, { type: "end", reason: "busy" });
    const label = room.hunt?.label ?? room.caller.label;
    room.state = { ...room.state, callee: userKey(userId) };
    room.hunt = undefined;
    room.group = undefined;
    this.roomsDirty = true;
    room.caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(room, targets, [], label);
    room.cancelTimer?.();
    room.cancelTimer = this.env.setTimer(
      () => void this.run(() => this.apply(room, { type: "timeout" })),
      await this.personRingMs(userId),
    );
  }

  /**
   * The caller would rather leave a voicemail than wait: for a line here, end the wait with the
   * line's offer; for a line elsewhere, ask its server (the offer comes back with `ended`).
   */
  private async lineVoicemail(peer: Peer, callId: string): Promise<void> {
    const room = this.rooms.get(callId);
    if (!room || room.caller !== peer || room.state.phase !== "ringing") return;
    if (room.farLine) {
      const far = room.calleePeer;
      if (far?.kind === "remote") (far.conn as FedConn).voicemail(room.id);
      return;
    }
    const state = room.line;
    if (!state || state.done || !room.vm) return;
    const line = await this.env.store.lines.get(state.groupId);
    if (!line || !mayLeaveVoicemailInstead(line)) return;
    state.waiting = false;
    state.done = true;
    this.roomsDirty = true;
    await this.apply(room, { type: "end", reason: "voicemail" });
  }

  // --- party line hours ----------------------------------------------------------------------

  /** A room's hours in the space's time zone (undefined: always open). */
  private async hoursOf(room: StoredRoom): Promise<RoomHours | undefined> {
    if (!room.hours) return undefined;
    const space = await this.env.store.getHousehold(this.householdId);
    return space ? { timeZone: space.timeZone, rules: room.hours } : undefined;
  }

  /** What each scheduled room needs now, without doing it. */
  private async roomHoursSteps(): Promise<
    { room: StoredRoom; hours: RoomHours; step: RoomHoursStep }[]
  > {
    const now = this.env.now();
    const out = [];
    for (const room of await this.env.store.rooms.list(this.householdId)) {
      const hours = await this.hoursOf(room);
      if (!hours) continue;
      const step = roomHoursStep(hours, now, {
        announcedUntil: room.announcedUntil,
        ...(this.closingWarned.has(room.id) ? { warnedFor: this.closingWarned.get(room.id) } : {}),
        occupied: (this.conf.get(room.id)?.participants.size ?? 0) > 0,
      });
      out.push({ room, hours, step });
    }
    return out;
  }

  /** The next time a scheduled room needs looking at (now, if something is due). */
  private async roomHoursDue(): Promise<number | undefined> {
    let at: number | undefined;
    for (const { step } of await this.roomHoursSteps()) {
      const due = step.announce || step.warn || step.close ? this.env.now() : step.next;
      if (due !== undefined) at = at === undefined ? due : Math.min(at, due);
    }
    return at;
  }

  /**
   * Party lines with hours: at opening tell its members (apps, and the phones with its key) once;
   * a minute before closing warn the people in it; at closing end it politely.
   */
  private async checkRoomHours(): Promise<void> {
    const now = this.env.now();
    for (const { room, hours, step } of await this.roomHoursSteps()) {
      if (step.announce) {
        await this.env.store.rooms.setAnnounced(room.id, step.announce.closesAt);
        await this.announceOpening(room, step.announce.closesAt);
      }
      const live = this.conf.get(room.id);
      if (step.warn && live) {
        this.closingWarned.set(room.id, step.warn.closesAt);
        for (const p of live.participants.values()) {
          p.peer.conn.send({
            t: "room.idle",
            roomId: room.id,
            dropAt: step.warn.closesAt,
            closing: true,
          });
        }
      }
      if (step.close) {
        this.closingWarned.delete(room.id);
        const opens = opensText(hours, now);
        await this.conf.close(room.id, opens ? `Closed. ${opens}` : "Closed");
      }
    }
  }

  /**
   * A room just opened: the space's apps hear it (`room.opened`), and the phones with its key get
   * a notice (`PARTY LINE OPEN` and its name, until it closes), with a chime. A kids' phone in
   * its quiet hours isn't told.
   */
  private async announceOpening(room: StoredRoom, closesAt: number): Promise<void> {
    const { store } = this.env;
    const name = room.name.slice(0, 40);
    for (const set of this.apps.values()) {
      for (const app of set) app.conn.send({ t: "room.opened", roomId: room.id, name, closesAt });
    }
    const schedule = await store.getSchedule(this.householdId);
    const now = new Date(this.env.now());
    const phones: string[] = [];
    for (const id of await store.rooms.phonesWith(room.id)) {
      const d = await store.getDevice(id);
      if (!d || d.householdId !== this.householdId) continue;
      if (deviceMode(d) === "kids" && isQuietAt(schedule, now)) continue;
      phones.push(id);
    }
    if (!phones.length) return;
    const title = room.kind === "party" ? "PARTY LINE OPEN" : "ROOM OPEN";
    await store.notices.create(
      {
        householdId: this.householdId,
        createdBy: null,
        authorName: name,
        lines: [
          title,
          name
            .toUpperCase()
            .replace(/[^ -~]/g, "?")
            .slice(0, 16),
        ],
        deviceIds: phones,
        expiresAt: closesAt,
      },
      this.env.now(),
    );
    await this.updateNotices();
  }

  /** A room's hours changed: open, warn or close it as they say now. */
  roomHoursChanged(): Promise<void> {
    return this.run(async () => {
      await this.checkRoomHours();
      await this.scheduleWake();
    });
  }

  // --- notices (docs/notices.md) ------------------------------------------------------------

  /** Notices changed (posted, recorded, taken down): every phone gets what it should show. */
  refreshNotices(): Promise<void> {
    return this.run(async () => {
      await this.updateNotices();
      await this.scheduleWake();
    });
  }

  private async updateNotices(): Promise<void> {
    const now = this.env.now();
    const live = await this.env.store.notices.live(this.householdId, now);
    for (const d of this.devices.values()) await this.refreshNotice(d, live);
    // Recordings of notices that are over go (and rows a week after).
    for (const key of await this.env.store.notices.sweep(this.householdId, now)) {
      await this.env.blobs.delete(key);
    }
  }

  /**
   * What one phone should show: the newest live notice meant for it that it hasn't dismissed.
   * Sent when that changes (a new notice, or its recording added); `notice.cleared` when it goes.
   */
  private async refreshNotice(device: DevicePeer, known?: StoredNotice[]): Promise<void> {
    const { store } = this.env;
    const now = this.env.now();
    const live = known ?? (await store.notices.live(this.householdId, now));
    const dismissed = await store.notices.dismissed(
      device.id,
      live.map((n) => n.id),
    );
    const n = noticeFor(live, device.id, dismissed, now);
    const sig = n ? `${n.id}:${n.audio?.token ?? ""}` : "";
    const before = device.noticeSig ?? "";
    if (sig === before) return;
    device.noticeSig = sig;
    if (n) {
      device.conn.send({
        t: "notice",
        id: n.id,
        lines: n.lines,
        from: n.authorName.slice(0, 24),
        at: n.createdAt,
        expiresAt: n.expiresAt,
        ...(n.audio ? { audio: { token: n.audio.token, durationMs: n.audio.durationMs } } : {}),
      });
    } else if (before) {
      device.conn.send({ t: "notice.cleared", id: before.split(":")[0] as string });
    }
  }

  // --- call me back (feature `line-callback`) ------------------------------------------------

  /**
   * A waiting caller would rather be called back: for a line here, keep their place (in the
   * store, so it survives the host sleeping) and end the call; for a line elsewhere, note that
   * we may let it ring them, and ask its server.
   */
  private async lineCallback(peer: Peer, callId: string): Promise<void> {
    const { store } = this.env;
    const room = this.rooms.get(callId);
    if (!room || room.caller !== peer || room.state.phase !== "ringing") return;
    const now = this.env.now();
    if (room.farLine) {
      const far = room.calleePeer;
      if (far?.kind !== "remote" || this.strictPhone(peer)) return;
      if (!(await peerSupports(this.env, far.host, "line-callback"))) return;
      const as = await this.callingAs(peer);
      const user = as && (await store.getUser(as.id));
      const addr = parseAddress(far.address ?? "");
      if (!as || !user || !addr) return;
      await store.lines.addGrant(
        {
          id: room.id,
          accountId: user.accountId,
          userId: user.id,
          householdId: this.householdId,
          lineHost: far.host ?? LOCAL_HOST,
          lineHandle: addr.handle,
          lineName: far.label,
          expiresAt: now + CALLBACK_KEEP_MS + CALLBACK_RING_MS * 4,
        },
        now,
      );
      (far.conn as FedConn).callback(room.id);
      return;
    }
    const state = room.line;
    if (!state?.waiting || state.done || !state.callback) return;
    const line = await store.lines.get(state.groupId);
    if (!line?.enabled || !mayOfferCallback(line)) return;
    const who = state.callback;
    const expiresAt = now + CALLBACK_KEEP_MS;
    await store.lines.addCallback(
      {
        id: room.id,
        groupId: state.groupId,
        householdId: this.householdId,
        since: state.since,
        host: who.host,
        accountId: who.accountId,
        handle: who.handle,
        name: state.name,
        address: state.address,
        expiresAt,
      },
      now,
    );
    if (peer.kind !== "remote") {
      // Someone here: their own grant, so the call back may ring them (same rules as elsewhere).
      const as = await this.callingAs(peer);
      if (as) {
        await store.lines.addGrant(
          {
            id: room.id,
            accountId: who.accountId,
            userId: as.id,
            householdId: this.householdId,
            lineHost: LOCAL_HOST,
            lineHandle: line.handle,
            lineName: state.info.name,
            expiresAt: expiresAt + CALLBACK_RING_MS * 4,
          },
          now,
        );
      }
    }
    this.callbacksPending = true;
    state.waiting = false;
    state.done = true;
    room.callbackUntil = expiresAt;
    room.vm = undefined;
    this.roomsDirty = true;
    await this.apply(room, { type: "end", reason: "hangup" });
    await this.scheduleWake();
  }

  /** Call backs whose place expired go; a call back nobody answered in time counts as missed. */
  private async expireCallbacks(rows: LineCallback[]): Promise<LineCallback[]> {
    const { store } = this.env;
    const now = this.env.now();
    const out: LineCallback[] = [];
    for (const row of rows) {
      if (row.expiresAt <= now) {
        if (await store.lines.takeCallback(row.id)) {
          await logLineCaller(this.env, {
            ...row,
            householdId: this.householdId,
            outcome: "call back expired",
          });
        }
        continue;
      }
      if (row.ringingUntil !== null && row.ringingUntil <= now) {
        const r = await this.missedCallback(row);
        if (r.retry) out.push((await store.lines.callback(row.id)) ?? row);
        continue;
      }
      out.push(row);
    }
    this.callbacksPending = out.length > 0;
    return out;
  }

  /**
   * It's the turn of someone waiting for a call back, and someone in the line's group is free:
   * ring them (here, or through their server). They call in again to take their place.
   */
  private async callBack(row: LineCallback): Promise<void> {
    const { store } = this.env;
    const line = await store.lines.get(row.groupId);
    const group = await store.workplace.group(row.groupId);
    if (!line?.enabled || !group) {
      await store.lines.takeCallback(row.id);
      return;
    }
    const space = await store.getHousehold(this.householdId);
    const spaceHours = await store.workplace.spaceHours(this.householdId);
    if (!space) return;
    const hours = effectiveHours(space.timeZone, group.hours, spaceHours.hours);
    if (!isOpen(hours, new Date(this.env.now()))) return; // closed: they keep waiting
    if (!(await this.huntFor(group, undefined)).length) return; // nobody free yet
    const until = this.env.now() + CALLBACK_RING_MS + CALLBACK_ANSWER_GRACE_MS;
    await store.lines.ringCallback(row.id, until);
    row.ringingUntil = until;
    const info = lineInfo(this.env, line, group);
    const calls = this.env.calls;
    // Over the network (or another hub's queue): never awaited inside this hub's queue.
    if (calls) {
      void calls
        .callbackDue(row.host, {
          id: row.id,
          to: row.handle,
          line: {
            handle: line.handle,
            name: info.name,
            ...(info.description ? { description: info.description } : {}),
          },
        })
        .catch((e) => this.env.log("warn", "call back failed", { error: String(e) }));
    }
  }

  /**
   * Someone didn't take a call back from one of our lines (declined, not answered, or no word
   * from their server in time): one more try at the end of the line, or the line's voicemail.
   */
  lineCallbackMissed(req: CallbackMissed): Promise<LineCallbackMissedResult> {
    return this.run(async () => {
      const row = await this.env.store.lines.callback(req.id);
      if (!row || row.host !== req.host || row.accountId !== req.accountId) return { retry: false };
      if (row.ringingUntil === null) return { retry: false };
      const result = await this.missedCallback(row);
      this.kickLines();
      return result;
    });
  }

  private async missedCallback(row: LineCallback): Promise<LineCallbackMissedResult> {
    const { store } = this.env;
    const line = await store.lines.get(row.groupId);
    const group = await store.workplace.group(row.groupId);
    const outcome = line ? afterMissedCallback(line, row.attempts + 1) : "drop";
    if (outcome === "retry") {
      // Back in line, at the end.
      await store.lines.ringCallback(row.id, null, await this.nextPlace());
      this.callbacksPending = true;
      return { retry: true };
    }
    if (!(await store.lines.takeCallback(row.id))) return { retry: false };
    const voicemail =
      outcome === "voicemail" && group
        ? await this.offer(
            {
              target: { kind: "group", groupId: group.id, name: group.name },
              from: { label: row.name.slice(0, 24), address: row.address },
            },
            "timeout",
            this.env.now(),
          )
        : undefined;
    await logLineCaller(this.env, {
      groupId: row.groupId,
      householdId: this.householdId,
      address: row.address,
      name: row.name,
      outcome: "missed call back",
    });
    return { retry: false, ...(voicemail ? { voicemail } : {}) };
  }

  /**
   * A public line (here or elsewhere) calls one of our people back: ring their apps and phones.
   * Answering calls the line again in their place; declining or no answer tells the line.
   */
  callbackRing(req: CallbackRing): Promise<void> {
    return this.run(async () => {
      if (this.callbackRings.has(req.id)) return;
      const targets = this.busy(userKey(req.userId)) ? [] : this.reachable(req.userId);
      const ringing: CallbackRinging = { req, targets };
      this.callbackRings.set(req.id, ringing);
      if (!targets.length) return this.callbackMissedHere(ringing, "unreachable");
      const address = `${req.line.handle}@${req.lineHost || ownHost(this.env)}`;
      const info = {
        name: req.line.name.slice(0, 64),
        ...(req.line.description ? { description: req.line.description } : {}),
        address,
      };
      for (const p of targets) {
        p.conn.send({
          t: "call.ringing",
          callId: req.id,
          from: { label: req.line.name.slice(0, 24), address },
          callback: info,
        });
      }
      ringing.cancel = this.env.setTimer(
        () => void this.run(() => this.callbackMissedHere(ringing, "timeout")),
        CALLBACK_RING_MS,
      );
    });
  }

  /** Answer or decline a line's call back (from one of the apps or phones it rings). */
  private async callbackReply(
    peer: Peer,
    id: string,
    ringing: CallbackRinging,
    answer: boolean,
  ): Promise<void> {
    if (ringing.done || !ringing.targets.includes(peer)) return;
    if (!answer) return this.callbackMissedHere(ringing, "declined");
    ringing.done = true;
    ringing.cancel?.();
    this.callbackRings.delete(id);
    for (const other of ringing.targets) {
      if (other !== peer) {
        other.conn.send({ t: "call.state", callId: id, state: "ended", reason: "hangup" });
      }
    }
    await this.env.store.lines.dropGrant(id);
    // Their call to the line goes on as a new call: they are its caller (like a transfer).
    const callId = newId("call");
    peer.conn.send({
      t: "call.state",
      callId: id,
      state: "ended",
      reason: "hangup",
      transfer: { callId, ringing: true, offerer: true },
    });
    const req = ringing.req;
    const address = `${req.line.handle}@${req.lineHost || ownHost(this.env)}`;
    await this.lineDial(peer, address, { callId, id });
  }

  /** Nobody took the call back: tell the line; it may try again later or offer voicemail. */
  private async callbackMissedHere(
    ringing: CallbackRinging,
    reason: "timeout" | "declined" | "unreachable",
  ): Promise<void> {
    if (ringing.done) return;
    ringing.done = true;
    ringing.cancel?.();
    const { req } = ringing;
    const calls = this.env.calls;
    const account = await this.env.store.getAccount(req.accountId);
    const finish = (result: LineCallbackMissedResult) =>
      this.run(async () => {
        this.callbackRings.delete(req.id);
        if (!result.retry) await this.env.store.lines.dropGrant(req.id);
        // Not taken (no answer, or no phone or app free): their phones show a missed call
        // naming the line until they clear it, call the line, or take its next call back.
        if (reason !== "declined") {
          await this.env.store.lines.addMissedCallback(
            {
              accountId: req.accountId,
              householdId: this.householdId,
              lineAddress: `${req.line.handle}@${req.lineHost || ownHost(this.env)}`,
              lineName: req.line.name,
            },
            this.env.now(),
          );
          await this.refreshAccountPhones(req.accountId);
        }
        let voicemail: VoicemailOffer | undefined;
        if (result.voicemail) {
          // A line here: its own offer. Elsewhere: ours, which forwards to its server.
          voicemail =
            req.lineHost === LOCAL_HOST
              ? result.voicemail
              : await this.offer(
                  {
                    target: {
                      kind: "relay",
                      host: req.lineHost,
                      ticket: result.voicemail.ticket,
                      name: result.voicemail.name,
                    },
                    from: {
                      userId: req.userId,
                      payer: req.accountId,
                      label: (account?.name ?? req.handle).slice(0, 24),
                      address: `user:${req.userId}`,
                    },
                  },
                  "timeout",
                  this.env.now(),
                );
        }
        for (const p of ringing.targets) {
          p.conn.send({
            t: "call.state",
            callId: req.id,
            state: "ended",
            reason: reason === "declined" ? "declined" : "timeout",
            ...(voicemail && p.kind === "user" ? { voicemail } : {}),
          });
        }
      });
    if (!calls || !account) return void finish({ retry: false });
    // Over the network (or another hub's queue): never awaited inside this hub's queue.
    void calls
      .callbackMissed(req.lineHost, {
        id: req.id,
        from: { handle: account.handle, id: account.id, name: account.name.slice(0, 64) },
        line: req.line.handle,
      })
      .then(finish, (e) => {
        this.env.log("warn", "missed call back not delivered", { error: String(e) });
        return finish({ retry: false });
      });
  }

  /**
   * Someone here calls a public line by its address (`call.line`, or a line on a phone's key):
   * a line of this space directly, any other through `/fed/v1/calls` (another household here is
   * reached the same way, without the network). Never from a kids' phone, nor from a Lounge
   * phone with nobody signed in (a line is called as a person; free phones call as the space).
   */
  private async lineDial(
    peer: Peer,
    address: string,
    /** Calling back in after the line's call back: the new call's id, and their place. */
    callback?: { callId: string; id: string },
  ): Promise<void> {
    const { store } = this.env;
    if (this.isKidsPhone(peer)) return this.refuse(peer, "denied", KIDS_NO_LINES);
    if (this.strictPhone(peer)) return this.refuse(peer, "denied", LEFT_PHONE_CANT_NOTE);
    if (
      peer.kind === "device" &&
      (peer as DevicePeer).lounge &&
      !(peer as DevicePeer).lounge?.session
    ) {
      return this.refuse(peer, "denied", SIGN_IN_FOR_LINES_NOTE);
    }
    const as = await this.callingAs(peer);
    const user = as && (await store.getUser(as.id));
    const account = user && (await store.getAccount(user.accountId));
    if (!as || !account) return this.refuse(peer, "denied");
    const addr = parseAddress(address);
    if (!addr) return this.refuse(peer, "unavailable");
    // Calling the line (or taking its call back) answers a missed call back from it.
    if (await store.lines.clearMissedCallbacks(account.id, `${addr.handle}@${addr.host}`)) {
      await this.refreshAccountPhones(account.id);
    }
    const party = partyOf(account);
    if (addr.host !== ownHost(this.env)) {
      return this.lineRemote(peer, as, party, addr.host, addr.handle, undefined, callback);
    }
    const line = await store.lines.byHandle(addr.handle);
    if (!line?.enabled) return this.refuse(peer, "unavailable");
    if (line.householdId !== this.householdId) {
      return this.lineRemote(peer, as, party, LOCAL_HOST, addr.handle, line.householdId, callback);
    }
    const callerAddress = `${account.handle}@${ownHost(this.env)}`;
    // Calling back in after the line's call back: their place in line (once).
    let since: number | undefined;
    if (callback) {
      const row = await store.lines.callback(callback.id);
      const theirs =
        row?.groupId === line.groupId && row.host === LOCAL_HOST && row.accountId === account.id;
      if (!row || !theirs || !(await store.lines.takeCallback(row.id))) {
        return this.refuse(peer, "unavailable");
      }
      since = row.since;
    }
    const admitted = await admitLineCall(
      this.env,
      line,
      {
        address: callerAddress,
        host: LOCAL_HOST,
        accountId: account.id,
        name: as.label,
        kidsPhone: false,
      },
      { counted: since === undefined },
    );
    if (!admitted) return this.refuse(peer, "unavailable");
    if (!this.canDial(peer)) return this.refuse(peer, "busy", CALLER_BUSY_NOTE);
    const allowance = await this.allowance(peer, as);
    if (allowance.note) return this.refuse(peer, "denied", allowance.note);
    const opened = await this.openToGroup(peer, line.groupId, as.label, {
      except: as.id,
      ...(callback ? { id: callback.callId } : {}),
      line: {
        line,
        address: callerAddress,
        name: as.label,
        ...(since !== undefined ? { since } : {}),
        callback: { host: LOCAL_HOST, accountId: account.id, handle: account.handle },
      },
    });
    const from = await this.vmCaller(peer, as.label, as);
    const vmOk = noQueueOutcome(line) === "voicemail";
    if (!("state" in opened)) {
      await this.lineRefused(line, callerAddress, as.label, opened);
      const vm = from && opened.vm && vmOk ? { target: opened.vm, from } : undefined;
      return this.refuse(peer, opened.reason, opened.note, vm);
    }
    opened.payer = allowance.payer;
    const target = vmOk ? await this.vmTargetOf(opened) : undefined;
    if (from && target) opened.vm = { target, from };
    this.roomsDirty = true;
    peer.conn.send({
      t: "call.state",
      callId: opened.id,
      state: "ringing",
      ...(opened.line ? { line: opened.line.info } : {}),
    });
    await this.sendQueue(line.groupId);
  }

  /** A public line in another household here (host '') or on another server. */
  private async lineRemote(
    peer: Peer,
    as: { id: string; label: string },
    from: Party,
    host: string,
    handle: string,
    peerHousehold: string | undefined,
    callback?: { callId: string; id: string },
  ): Promise<void> {
    return this.dialRemote(peer, {
      as,
      host,
      // A line takes many callers at once: the far side is busy only for this caller.
      key: `fed:${host}:line:${handle}:${peer.key}`,
      label: handle.slice(0, 24),
      peerHousehold,
      body: {
        from,
        to: { kind: "line", handle, ...(callback ? { callback: callback.id } : {}) },
      },
      line: true,
      ...(callback ? { callId: callback.callId } : {}),
    });
  }

  /**
   * Someone elsewhere calls one of our public lines (already admitted by `admitLineCall`): ring
   * its members, or let them wait in its queue. The line's voicemail offer goes to their server,
   * which relays it to them.
   */
  private async lineRing(
    groupId: string,
    req: {
      host: string;
      key: string;
      label: string;
      peerHousehold: string | undefined;
      callId: string;
      address: string;
      /** Their account on their server (offered "call me back" if their server can do it). */
      from?: { id: string; handle: string };
      /** Calling back in after the line's call back: their place in line. */
      callbackSince?: number;
    },
  ): Promise<RingResult> {
    const line = await this.env.store.lines.get(groupId);
    if (!line?.enabled || line.householdId !== this.householdId) {
      return { state: "ended", reason: "unavailable" };
    }
    const remote = this.remotePeer({
      host: req.host,
      key: req.key,
      label: req.label,
      peerHousehold: req.peerHousehold,
      address: req.address,
      line: true,
    });
    const canCallBack =
      req.from !== undefined && (await peerSupports(this.env, req.host, "line-callback"));
    const opened = await this.openToGroup(remote, groupId, req.label, {
      id: req.callId,
      line: {
        line,
        address: req.address,
        name: req.label,
        ...(req.callbackSince !== undefined ? { since: req.callbackSince } : {}),
        ...(canCallBack && req.from
          ? { callback: { host: req.host, accountId: req.from.id, handle: req.from.handle } }
          : {}),
      },
    });
    const from: VmCaller = { label: req.label, address: req.address };
    const vmOk = noQueueOutcome(line) === "voicemail";
    if (!("state" in opened)) {
      await this.lineRefused(line, req.address, req.label, opened);
      const voicemail =
        opened.vm && vmOk
          ? await this.offer({ target: opened.vm, from }, opened.reason, this.env.now())
          : undefined;
      return {
        state: "ended",
        reason: opened.reason,
        ...(opened.note ? { note: opened.note } : {}),
        ...(voicemail ? { voicemail } : {}),
      } as RingResult;
    }
    const target = vmOk ? await this.vmTargetOf(opened) : undefined;
    if (target) opened.vm = { target, from };
    this.roomsDirty = true;
    remote.conn.send({
      t: "call.state",
      callId: opened.id,
      state: "ringing",
      ...(opened.line ? { line: opened.line.info } : {}),
    });
    await this.sendQueue(groupId);
    return { state: "ringing" };
  }

  /** A line's caller who never got in line (closed, queue full or off), for "Recent callers". */
  private async lineRefused(
    line: PublicLine,
    address: string,
    name: string,
    r: Refusal,
  ): Promise<void> {
    const outcome =
      r.note === CLOSED_NOTE ? "closed" : r.reason === "busy" ? "line full" : "nobody free";
    await logLineCaller(this.env, {
      groupId: line.groupId,
      householdId: this.householdId,
      address,
      name,
      outcome,
    });
  }

  // --- recording (docs/security-model.md) ------------------------------------------------

  /** A kids' phone: a household phone of ours without an owner, or one elsewhere we know of. */
  private isKidsPhone(p: Peer): boolean {
    if (p.kind === "remote") return p.kidsPhone === true;
    if (p.kind !== "device") return false;
    const d = p as DevicePeer;
    return !d.owner && !d.lounge && d.left === undefined;
  }

  /**
   * A phone under kids' rules for what it may do: a kids' phone, or the phone of someone who
   * left (nobody answers for it, so it gets the strictest rules without being a kids' phone).
   */
  private strictPhone(p: Peer): boolean {
    return this.isKidsPhone(p) || (p.kind === "device" && p.left !== undefined);
  }

  /**
   * Whether this space records a call or room with these parties: its name if so. Off unless the
   * space turned it on; never in a home with kids' phones, never with a kids' phone taking part.
   */
  private async recordingBy(parties: Peer[]): Promise<string | undefined> {
    const { store } = this.env;
    const enabled = await store.recordings.enabled(this.householdId);
    if (!enabled) return undefined;
    const kidsPhones = (await store.listDevices(this.householdId)).filter(
      (d) => deviceMode(d) === "kids",
    ).length;
    const decision = recordingDecision({
      enabled,
      spaceKidsPhones: kidsPhones,
      // Nor with a phone of someone who left: nobody there agreed to it.
      kidsPhoneOnCall: parties.some((p) => this.strictPhone(p)),
    });
    if (!decision.record) return undefined;
    return (await store.getHousehold(this.householdId))?.name.slice(0, 64);
  }

  /** Who a recording made by `p` belongs to: the person at that app or phone. */
  private async recorderAccount(p: Peer): Promise<string | null> {
    const person = p.kind === "user" ? p.id : p.kind === "device" ? personOf(p) : undefined;
    if (!person || person.startsWith("guest:")) return null;
    return (await this.env.store.getUser(person))?.accountId ?? null;
  }

  /**
   * The call is live: if this space records it, every party is told — our people directly, the
   * far side through its server — and only then does the recording side's own client get its
   * upload ticket. There is no way to get a ticket without that announcement going out first.
   */
  private async announceRecording(room: Room): Promise<void> {
    if (room.noRecording || room.recording?.ours) return;
    const parties = [room.caller, room.calleePeer].filter((p): p is Peer => !!p);
    // A hub that only relays between two other places records nothing: their spaces decide.
    if (!parties.some((p) => p.kind !== "remote")) return;
    const by = await this.recordingBy(parties);
    if (!by || this.rooms.get(room.id) !== room) return;
    // Everyone is told a call is recorded. A party whose server can't pass that on (no
    // `recording-flag`) can't be told, so the call ends instead of being recorded unannounced.
    for (const p of parties) {
      if (p.kind === "remote" && !(await peerSupports(this.env, p.host, "recording-flag"))) {
        if (this.rooms.get(room.id) !== room) return;
        room.endNote = UNAVAILABLE["recording-flag"];
        return this.apply(room, { type: "end", reason: "denied" });
      }
    }
    if (this.rooms.get(room.id) !== room) return;
    room.recording = { by, ours: true };
    this.roomsDirty = true;
    const recorderId = pickRecorder(
      parties.map((p) => ({
        id: p.session,
        local: p.kind !== "remote",
        canRecord: p.kind === "user" || p.canRecord === true,
      })),
    );
    const notice = {
      t: "call.state",
      callId: room.id,
      state: "active",
      recording: { by },
    } as const;
    for (const p of parties) if (p.session !== recorderId) p.conn.send(notice);
    const recorder = parties.find((p) => p.session === recorderId);
    if (!recorder) return;
    const other = parties.find((p) => p !== recorder);
    const who = await this.describe(other, other?.key ?? "");
    const ticket = await this.env.store.recordings.createTicket(
      {
        householdId: this.householdId,
        kind: "call",
        callId: room.id,
        accountId: await this.recorderAccount(recorder),
        peer: who.peer,
        peerLabel: who.label.slice(0, 64),
        startedAt: room.activeAt ?? this.env.now(),
      },
      this.env.now(),
    );
    recorder.conn.send({
      ...notice,
      recording: { by, ticket, maxMs: RECORDING_MAX_MS },
    });
  }

  /**
   * The far side's space records the call: tell our person (never with a ticket — the recording
   * is theirs), or end the call if this server doesn't take recorded calls from other servers.
   */
  private async farRecording(
    room: Room,
    remote: Peer,
    party: "caller" | "callee",
    by: string,
  ): Promise<void> {
    if (room.state.phase !== "active" && room.state.phase !== "connecting") return;
    if (this.env.refuseRecordedCalls && (remote.host ?? LOCAL_HOST) !== LOCAL_HOST) {
      room.endNote = REFUSES_RECORDING;
      return this.apply(room, { type: "end", reason: "denied" });
    }
    if (room.recording) return;
    room.recording = { by: by.slice(0, 64), ours: false };
    this.roomsDirty = true;
    const other = party === "caller" ? room.calleePeer : room.caller;
    other?.conn.send({
      t: "call.state",
      callId: room.id,
      state: "active",
      recording: { by: by.slice(0, 64) },
    });
  }

  // --- hold, 3-way and transfer ---------------------------------------------------------

  /** The other party of a call, from `peer`'s side. */
  private otherParty(room: Room, peer: Peer): Peer | undefined {
    if (room.caller === peer) return room.calleePeer;
    if (room.calleePeer === peer) return room.caller;
    return undefined;
  }

  /** The name to show for a party in a room. */
  private displayName(peer: Peer): string {
    if (peer.kind === "device") return peer.lounge?.session?.name ?? peer.label;
    return peer.label;
  }

  private refuseControl(peer: Peer, message: string): void {
    peer.conn.send({ t: "error", code: "bad_message", message });
  }

  /** On hold: the holder's audio stops and the other side hears a soft tone (played locally). */
  private async hold(peer: Peer, callId: string, hold: boolean, except?: string): Promise<void> {
    const room = this.rooms.get(callId);
    const other = room && this.otherParty(room, peer);
    if (!room || !other) return this.refuseControl(peer, "no such call");
    // `except`: a waiting call being answered (it doesn't count as another call yet).
    const calls = this.partyCalls(peer).filter((c) => c.callId !== except);
    const check = controlCheck(calls, { type: "hold", callId, hold });
    if (!check.ok) return this.refuseControl(peer, check.error);
    const was = room.heldBy;
    room.heldBy = hold ? peer.key : undefined;
    this.roomsDirty = true;
    if (was === room.heldBy) return;
    peer.conn.send({ t: "call.state", callId, state: "active", ...(hold ? { hold: "you" } : {}) });
    other.conn.send({
      t: "call.state",
      callId,
      state: "active",
      ...(hold ? { hold: "them" } : {}),
    });
  }

  /**
   * How a party counts for the kids'-phone rule: a kids' phone with the keys on its allow-list,
   * everyone else as the person they are.
   */
  private async meeting(p: Peer): Promise<Meeting> {
    if (p.kind === "device") {
      const device = p as DevicePeer;
      if (!device.owner && !device.lounge) {
        const allowed = new Set<string>();
        for (const c of await this.env.store.listContacts(device.id)) {
          if (!isRemoteContactId(c.id) && !isRoomContactId(c.id) && !isLineContactId(c.id)) {
            allowed.add(userKey(c.id));
          }
        }
        for (const r of await this.env.store.listRemoteContacts(device.id)) {
          if (r.connection.peerAccount) {
            allowed.add(`fed:${r.connection.peerHost}:${r.connection.peerAccount}`);
          }
        }
        return { key: p.key, kidsPhone: { allowed } };
      }
      const person = personOf(device);
      return { key: person ? userKey(person) : p.key };
    }
    return { key: p.key };
  }

  private async kidsMayMeet(parties: Peer[]): Promise<boolean> {
    return mayConnect(await Promise.all(parties.map((p) => this.meeting(p))));
  }

  /** Ends a call that became part of a room: logged and metered, no end signal to its far end. */
  private async endMerged(room: Room, roomId: string): Promise<void> {
    room.cancelTimer?.();
    this.rooms.delete(room.id);
    this.roomsDirty = true;
    await this.closeBooks(room, "hangup");
    for (const p of [room.caller, room.calleePeer]) {
      p?.conn.send({
        t: "call.state",
        callId: room.id,
        state: "ended",
        reason: "hangup",
        merged: { roomId },
      });
    }
  }

  /** Call log and fair-use metering for a call that's over (however it ended). */
  private async closeBooks(room: Room, reason: string): Promise<void> {
    await this.logCall(room, reason).catch((e) =>
      this.env.log("warn", "call log failed", { error: String(e) }),
    );
    if (room.payer && room.activeAt !== undefined) {
      const minutes = Math.ceil((this.env.now() - room.activeAt) / 60_000);
      await this.env.store.addUsage(room.payer, this.env.now(), { callMinutes: minutes });
    }
  }

  /**
   * 3-way: the call on hold and the live (consult) call become one room with all three. The old
   * calls' audio keeps playing until the room's is connected, so nobody hears a gap.
   */
  private async merge(peer: Peer, heldId: string, activeId: string): Promise<void> {
    const r1 = this.rooms.get(heldId);
    const r2 = this.rooms.get(activeId);
    const check = controlCheck(this.partyCalls(peer), {
      type: "merge",
      held: heldId,
      active: activeId,
    });
    if (!check.ok || !r1 || !r2)
      return this.refuseControl(peer, check.ok ? "no such call" : check.error);
    const b = this.otherParty(r1, peer);
    const c = this.otherParty(r2, peer);
    if (!b || !c) return this.refuseControl(peer, "no such call");
    if (isAddonParty(b) || isAddonParty(c)) return this.refuseControl(peer, ADDON_ONE_TO_ONE);
    if (!(await this.kidsMayMeet([peer, b, c]))) {
      return this.refuseControl(peer, "a kids' phone can only be with people on its list");
    }
    // A merge turns a call with another server into a room leg there: only with servers that
    // have rooms (and, if this space records, that can announce it).
    const recorded = (await this.recordingBy([peer, b, c])) !== undefined;
    for (const other of [b, c]) {
      if (other.kind !== "remote") continue;
      if (!(await peerSupports(this.env, other.host, "rooms"))) {
        return this.refuseControl(peer, UNAVAILABLE.rooms);
      }
      if (recorded && !(await peerSupports(this.env, other.host, "recording-flag"))) {
        return this.refuseControl(peer, RECORDED_ROOM_UNAVAILABLE);
      }
    }
    const payer = (await this.allowance(peer)).payer;
    const room = this.conf.openCall("3-way call");
    await this.endMerged(r1, room.id);
    await this.endMerged(r2, room.id);
    await this.conf.admit(room, peer, {
      name: this.displayName(peer),
      host: true,
      ...(payer ? { payer } : {}),
    });
    for (const [other, call] of [
      [b, r1],
      [c, r2],
    ] as const) {
      if (other.kind === "remote") {
        // Same far end, now as a room leg under the call's id (their server converts it).
        const leg = other.leg ?? call.id;
        (other.conn as FedConn).useLeg(leg);
        const remote: Peer = { ...other, leg };
        await this.conf.admit(room, remote, {
          name: other.label,
          ...(other.host ? { remoteHost: other.host } : {}),
          // Their own server meters them; someone from another server counts against the host.
          ...(other.host && payer ? { payer } : {}),
        });
      } else {
        const own = (await this.allowance(other)).payer;
        await this.conf.admit(room, other, {
          name: this.displayName(other),
          ...(own ? { payer: own } : {}),
        });
      }
    }
  }

  /** Transfer: blind (ring a target for them) or attended (connect your two other parties). */
  private async transfer(
    peer: Peer,
    msg: { callId: string; to?: TransferTarget; toCall?: string },
  ): Promise<void> {
    if (msg.toCall) return this.transferAttended(peer, msg.callId, msg.toCall);
    const room = this.rooms.get(msg.callId);
    const other = room && this.otherParty(room, peer);
    const check = controlCheck(this.partyCalls(peer), { type: "transfer", callId: msg.callId });
    if (!room || !other || !check.ok || !msg.to) {
      return this.refuseControl(peer, check.ok ? "no such call" : check.error);
    }
    if (isAddonParty(other)) return this.refuseControl(peer, ADDON_ONE_TO_ONE);
    // Someone in another household or on another server: only inside a team/org space.
    if (other.kind === "remote") return this.transferRemote(peer, room, other, msg.to);
    const target = await this.transferTarget(peer, msg.to);
    if (!target) return this.refuseControl(peer, "transfer refused: not allowed");
    // They call the target themselves, with their own permissions: step the call aside, dial
    // as them, and keep what they'd have been told until it's clear whether it worked.
    this.rooms.delete(room.id);
    const real = other.conn;
    const held: (ServerToDevice | ServerToApp)[] = [];
    other.conn = {
      send: (m) => void held.push(m),
      close: (code, reason) => real.close(code, reason),
      ...(real.remember ? { remember: (memo) => real.remember?.(memo) } : {}),
    };
    const before = new Set(this.rooms.keys());
    try {
      await this.dialAs(other, target);
    } finally {
      other.conn = real;
    }
    const next = [...this.rooms.values()].find((r) => !before.has(r.id) && r.caller === other);
    if (!next) {
      this.rooms.set(room.id, room);
      const why = held.find((m) => m.t === "call.state" && m.state === "ended");
      const note = why?.t === "call.state" ? (why.note ?? why.reason) : undefined;
      return this.refuseControl(peer, `transfer refused${note ? `: ${note}` : ""}`);
    }
    this.roomsDirty = true;
    await this.closeBooks(room, "hangup");
    peer.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
    real.send({
      t: "call.state",
      callId: room.id,
      state: "ended",
      reason: "hangup",
      transfer: { callId: next.id, ringing: true, offerer: true },
    });
    for (const m of held) real.send(m);
  }

  /** What a transfer target means for the person being transferred. */
  private async transferTarget(by: Peer, to: TransferTarget): Promise<DialTarget | undefined> {
    if (!("button" in to)) return to;
    // A key on the transferring phone: its allow-list entry for that key.
    if (by.kind !== "device") return undefined;
    const id = (await this.env.store.listButtons(by.id)).get(to.button);
    if (!id || isRoomContactId(id) || isLineContactId(id)) return undefined;
    if (isRemoteContactId(id)) {
      const entry = (await this.env.store.listRemoteContacts(by.id)).find((r) => r.id === id);
      return entry ? { connectionId: entry.connectionId } : undefined;
    }
    return { userId: id };
  }

  /** Places a call as `who` (the person being transferred), under their own rules. */
  private async dialAs(who: Peer, target: DialTarget): Promise<void> {
    if ("extension" in target) return this.extensionDial(who, target.extension);
    if ("groupId" in target) {
      const as = await this.callingAs(who);
      if (!as || !(await this.isWorkplace())) return this.refuse(who, "denied");
      return this.placeInSpace(who, as, { groupId: target.groupId });
    }
    if (who.kind === "device") {
      const device = who as DevicePeer;
      if (device.lounge) {
        const s = device.lounge.session;
        if (!s || s.guest) return;
        const as = { id: s.userId, label: s.name };
        if ("userId" in target) return this.userDial(device, target.userId, as);
        if ("deviceId" in target) return this.appDial(device, target.deviceId, as);
        return this.connectionDial(device, target.connectionId, as);
      }
      // A phone may only reach what's on its own allow-list, as if a key were pressed.
      let contact: Contact | undefined;
      if ("userId" in target) contact = await this.env.store.getContact(device.id, target.userId);
      else if ("connectionId" in target) {
        contact = (await this.env.store.listRemoteContacts(device.id)).find(
          (r) => r.connectionId === target.connectionId,
        );
      }
      if (!contact) return this.refuse(device, "denied");
      const allowance = await this.allowance(device);
      if (allowance.note) return this.refuse(device, "denied", allowance.note);
      return this.dialContact(device, contact, await this.scheduleFor(device), allowance);
    }
    if ("userId" in target) return this.userDial(who, target.userId);
    if ("deviceId" in target) return this.appDial(who, target.deviceId);
    return this.connectionDial(who, target.connectionId);
  }

  /**
   * A transfer target inside this team/org space: a member, a phone (not a kids' phone), a ring
   * group, or an extension naming one of those. Anything else (a connection, a room, someone in
   * another space) is undefined.
   */
  private async spaceTarget(by: Peer, to: TransferTarget): Promise<SpaceTarget | undefined> {
    const { store } = this.env;
    let t: TransferTarget | DialTarget | undefined = to;
    if ("button" in to) t = await this.transferTarget(by, to);
    if (!t) return undefined;
    if ("extension" in t) {
      const ext = await store.workplace.extension(this.householdId, t.extension);
      if (!ext || ext.kind === "room") return undefined;
      t =
        ext.kind === "user"
          ? { userId: ext.targetId }
          : ext.kind === "device"
            ? { deviceId: ext.targetId }
            : { groupId: ext.targetId };
    }
    if ("userId" in t) {
      const user = await store.getUser(t.userId);
      return user?.householdId === this.householdId ? { userId: user.id } : undefined;
    }
    if ("deviceId" in t) {
      const d = await store.getDevice(t.deviceId);
      return d?.householdId === this.householdId &&
        (deviceMode(d) === "personal" || deviceMode(d) === "lounge")
        ? { deviceId: d.id }
        : undefined;
    }
    if ("groupId" in t) {
      const g = await store.workplace.group(t.groupId);
      return g?.householdId === this.householdId ? { groupId: g.id } : undefined;
    }
    return undefined;
  }

  /** A fresh proxy for the same far end, for a call that goes on under a new id here. */
  private successor(far: Peer, leg?: string, transferred = false): Peer {
    const next = this.remotePeer({
      host: far.host ?? LOCAL_HOST,
      key: far.key,
      label: far.label,
      peerHousehold: far.peerHousehold,
      ...(leg ? { leg } : {}),
      ...(far.address ? { address: far.address } : {}),
      ...(transferred ? { transferred: true } : {}),
    });
    (next.conn as FedConn).shareLine(far.conn as FedConn);
    return next;
  }

  /**
   * Blind transfer of someone in another household or on another server. Allowed only in a
   * team/org space, to its own members, phones, ring groups and extensions: the space vouches
   * for them there, and their own server re-checks its side (a kids' phone is never
   * transferred). The call rings the target here under a new id; their server is told
   * (`call.state` ended with `transfer`) and carries their person over to it.
   */
  private async transferRemote(
    peer: Peer,
    room: Room,
    other: Peer,
    to: TransferTarget,
  ): Promise<void> {
    const calls = this.env.calls;
    if (!calls || !(await this.isWorkplace())) return this.refuseControl(peer, REMOTE_TRANSFER);
    if (!(await peerSupports(this.env, other.host, "transfer"))) {
      return this.refuseControl(peer, UNAVAILABLE.transfer);
    }
    const target = await this.spaceTarget(peer, to);
    const self = await this.callingAs(peer);
    if (!target || ("userId" in target && target.userId === self?.id)) {
      return this.refuseControl(peer, REMOTE_TARGET);
    }
    const id = newId("call");
    // If the target doesn't answer, they get our voicemail offer (as a caller from here would).
    const far = this.successor(other, undefined, true);
    // Step the call aside while the target is tried (busy checks use the far end's key).
    this.rooms.delete(room.id);
    const opened =
      "userId" in target
        ? await this.openToUser(far, target.userId, other.label, id)
        : "deviceId" in target
          ? await this.openToPhone(far, target.deviceId, other.label, id)
          : await this.openToGroup(far, target.groupId, other.label, {
              id,
              ...(self ? { except: self.id } : {}),
            });
    if (!("state" in opened)) {
      this.rooms.set(room.id, room);
      return this.refuseControl(peer, `transfer refused: ${opened.note ?? opened.reason}`);
    }
    opened.payer = room.payer;
    // Unanswered, it goes to the target's voicemail here (a ring group's box, or the person),
    // exactly like a local caller's transfer; their server relays the offer (`relayOffer`).
    const vmTarget = await this.vmTargetOf(opened);
    if (vmTarget) {
      opened.vm = {
        target: vmTarget,
        from: {
          label: other.label,
          address: other.address ?? `remote:${other.host ?? LOCAL_HOST}`,
          ...(room.payer ? { payer: room.payer } : {}),
        },
      };
    }
    await calls.register(far.host ?? LOCAL_HOST, id, this.householdId);
    this.handoffs.set(`${other.host ?? LOCAL_HOST}|${other.leg ?? room.id}`, id);
    room.cancelTimer?.();
    await this.closeBooks(room, "hangup");
    peer.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
    other.conn.send({
      t: "call.state",
      callId: room.id,
      state: "ended",
      reason: "hangup",
      transfer: { callId: id, ringing: true, offerer: true },
    });
  }

  /**
   * The far end of our call transferred it (a team/org space on their side, see
   * `transferRemote`): the call goes on under a new id with the same server, `t.callId` there.
   * Our person (or the server we relay for) follows; a kids' phone never does — its call just
   * ends, so a transfer can't put it with someone who isn't on its list.
   */
  private async repoint(
    room: Room,
    remote: Peer,
    t: { callId: string; ringing: boolean; offerer: boolean },
  ): Promise<void> {
    const near = remote === room.caller ? room.calleePeer : room.caller;
    const calls = this.env.calls;
    const answered = room.state.phase === "connecting" || room.state.phase === "active";
    const device = near?.kind === "device" ? (near as DevicePeer) : undefined;
    const kidsPhone = !!device && !device.owner && !device.lounge;
    // A ringing successor is always one our side places (it can't ring our person).
    const sound = t.offerer || !t.ringing;
    if (!near || !calls || !answered || kidsPhone || !sound) {
      return this.apply(room, { type: "end", reason: "hangup" });
    }
    room.cancelTimer?.();
    this.rooms.delete(room.id);
    this.roomsDirty = true;
    await this.closeBooks(room, "hangup");
    const id = newId("call");
    // Transferred by their space: if nobody answers there, their voicemail offer is relayed.
    const far = this.successor(remote, t.callId, true);
    await calls.register(far.host ?? LOCAL_HOST, t.callId, this.householdId);
    // Relaying for another household or server: its side follows under our new id.
    const ours = near.kind === "remote" ? this.successor(near) : near;
    if (ours !== near) await calls.register(ours.host ?? LOCAL_HOST, id, this.householdId);
    const backstop = MAX_RING_SECONDS * 1000 + 5_000;
    const next = t.offerer
      ? this.openRoom(ours, far.key, id, backstop)
      : this.openRoom(far, ours.key, id, backstop);
    next.calleePeer = t.offerer ? far : ours;
    if (room.payer) next.payer = room.payer;
    this.roomsDirty = true;
    near.conn.send({
      t: "call.state",
      callId: room.id,
      state: "ended",
      reason: "hangup",
      transfer: { callId: id, ringing: t.ringing, offerer: t.offerer },
    });
    if (!t.ringing) await this.apply(next, { type: "answer", by: next.state.callee });
  }

  /** Attended transfer: your held party and your consult party are connected; you leave both. */
  private async transferAttended(peer: Peer, heldId: string, activeId: string): Promise<void> {
    const r1 = this.rooms.get(heldId);
    const r2 = this.rooms.get(activeId);
    const check = controlCheck(this.partyCalls(peer), {
      type: "transfer-attended",
      held: heldId,
      active: activeId,
    });
    if (!check.ok || !r1 || !r2)
      return this.refuseControl(peer, check.ok ? "no such call" : check.error);
    const b = this.otherParty(r1, peer);
    const c = this.otherParty(r2, peer);
    if (!b || !c) return this.refuseControl(peer, "no such call");
    if (isAddonParty(b) || isAddonParty(c)) return this.refuseControl(peer, ADDON_ONE_TO_ONE);
    const remotes = [b, c].filter((p) => p.kind === "remote").length;
    // Someone elsewhere may be connected only with someone of this team/org space.
    if (remotes === 2 || (remotes === 1 && !(await this.isWorkplace()))) {
      return this.refuseControl(peer, REMOTE_TRANSFER);
    }
    if (!(await this.kidsMayMeet([b, c]))) {
      return this.refuseControl(peer, "a kids' phone can only be with people on its list");
    }
    const calls = this.env.calls;
    if (remotes && !calls) return this.refuseControl(peer, REMOTE_TRANSFER);
    for (const r of [r1, r2]) {
      r.cancelTimer?.();
      this.rooms.delete(r.id);
      await this.closeBooks(r, "hangup");
      peer.conn.send({ t: "call.state", callId: r.id, state: "ended", reason: "hangup" });
    }
    const id = newId("call");
    // A far end goes on under the new id (its server follows the `transfer` notice).
    const b2 = b.kind === "remote" ? this.successor(b) : b;
    const c2 = c.kind === "remote" ? this.successor(c) : c;
    for (const p of [b2, c2]) {
      if (p.kind === "remote") await calls?.register(p.host ?? LOCAL_HOST, id, this.householdId);
    }
    const room = this.openRoom(b2, c2.key, id);
    if (b !== b2) this.handoffs.set(`${b.host ?? LOCAL_HOST}|${b.leg ?? r1.id}`, id);
    if (c !== c2) this.handoffs.set(`${c.host ?? LOCAL_HOST}|${c.leg ?? r2.id}`, id);
    room.payer = r1.payer;
    room.calleePeer = c2;
    room.answered = true;
    this.roomsDirty = true;
    b.conn.send({
      t: "call.state",
      callId: r1.id,
      state: "ended",
      reason: "hangup",
      transfer: { callId: room.id, ringing: false, offerer: true },
    });
    c.conn.send({
      t: "call.state",
      callId: r2.id,
      state: "ended",
      reason: "hangup",
      transfer: { callId: room.id, ringing: false, offerer: false },
    });
    await this.apply(room, { type: "answer", by: room.state.callee });
  }

  // --- rooms ------------------------------------------------------------------------------

  /** A participant's message about their room: held here, or relayed to where it's held. */
  private async roomMessage(peer: Peer, msg: RoomInbound): Promise<void> {
    const roomId = msg.t === "rtc.sdp" || msg.t === "rtc.ice" ? msg.callId : msg.roomId;
    const here = this.conf.find(peer, roomId);
    if (here) return this.conf.message(here.room, here.p, msg);
    const leg = [...this.legs.values()].find((l) => l.peer === peer && l.roomId === roomId);
    if (leg) {
      leg.conn.room(msg as RoomSignalMsg);
      if (msg.t === "room.leave")
        await this.endLeg(leg, "left", { tellRoom: false, tellPeer: true });
      return;
    }
    if (msg.t === "room.leave") peer.conn.send({ t: "room.ended", roomId, reason: "left" });
  }

  /** Refuses a join with a reason (and the server's words, if any). */
  private refuseRoom(peer: Peer, reason: RoomEndReason, roomId?: string, note?: string): void {
    peer.conn.send({
      t: "room.ended",
      ...(roomId ? { roomId } : {}),
      reason,
      ...(note ? { note } : {}),
    });
  }

  /** `name@host` of a phone room here. */
  private roomAddress(r: StoredRoom): string | undefined {
    return r.handle ? `${r.handle}@${ownHost(this.env)}` : undefined;
  }

  private async joinById(peer: Peer, roomId: string): Promise<void> {
    const stored = await this.env.store.rooms.get(roomId);
    if (!stored || stored.householdId !== this.householdId) {
      return this.refuseRoom(peer, "denied", roomId);
    }
    return this.joinLocal(peer, stored);
  }

  /** A kids' or personal phone's key for a room on its allow-list. */
  private async joinFromPhone(device: DevicePeer, contactId: string): Promise<void> {
    const entry = await this.env.store.rooms.contact(device.id, contactId);
    const stored = entry ? await this.env.store.rooms.get(entry.roomId) : undefined;
    // Phones join only their own space's rooms.
    if (!stored || stored.householdId !== this.householdId)
      return this.refuseRoom(device, "denied");
    return this.joinLocal(device, stored);
  }

  /**
   * Someone connected to this hub joins one of its space's rooms. Default deny: the space's
   * members (their apps, own phones, Lounge phones they're at); kids' phones only with the room on
   * their allow-list. Then lock, size, and the joiner's fair-use allowance.
   */
  private async joinLocal(peer: Peer, stored: StoredRoom): Promise<void> {
    if (this.busy(peer.key)) return this.refuseRoom(peer, "busy", stored.id);
    // A party line with hours is closed outside them.
    const hours = await this.hoursOf(stored);
    if (!roomOpenAt(hours, this.env.now()).open) {
      const opens = opensText(hours, this.env.now());
      return this.refuseRoom(peer, "closed", stored.id, opens ? `Closed. ${opens}` : "Closed");
    }
    const { store } = this.env;
    let kidsPhone: { allowListed: boolean } | undefined;
    let account: string | undefined;
    if (peer.kind === "device") {
      const device = peer as DevicePeer;
      const session = device.lounge?.session;
      if (device.lounge && (!session || session.guest))
        return this.refuseRoom(peer, "denied", stored.id);
      const person = personOf(device);
      if (!person) kidsPhone = { allowListed: await store.rooms.allowedOn(device.id, stored.id) };
      else account = (await store.getUser(person))?.accountId;
    } else account = (await store.getUser(peer.id))?.accountId;
    const live = this.conf.get(stored.id);
    const media = live?.media ?? this.conf.mediaKind();
    const decision = roomAccess(
      {
        kind: stored.kind,
        access: stored.access,
        locked: live?.locked ?? stored.locked,
        size: live?.participants.size ?? 0,
        max: this.conf.maxSize(media),
      },
      { inSpace: true, connected: false, ...(kidsPhone ? { kidsPhone } : {}) },
    );
    if (!decision.ok) return this.refuseRoom(peer, decision.reason, stored.id);
    const payer = account ?? (kidsPhone ? await store.spaceOwner(this.householdId) : undefined);
    const note = await fairUseProblem(this.env, payer, "room");
    if (note) return this.refuseRoom(peer, "denied", stored.id, note);
    const guardian = peer.kind === "user" && peer.guardian;
    const address = this.roomAddress(stored);
    const room = this.conf.open({ ...stored, ...(address ? { address } : {}) });
    await this.conf.admit(room, peer, {
      name: this.displayName(peer),
      // The room's owner hosts it; in a home, guardians may too.
      host: (!!account && account === stored.ownerAccount) || guardian,
      ...(payer ? { payer } : {}),
    });
  }

  /** Joins a phone room by address: here, in another household here, or on another server. */
  private async joinByAddress(peer: Peer, address: string): Promise<void> {
    const { store } = this.env;
    const addr = parseAddress(address);
    if (!addr) return this.refuseRoom(peer, "denied");
    const host = addr.host === ownHost(this.env) ? LOCAL_HOST : addr.host;
    let householdId: string | undefined;
    if (host === LOCAL_HOST) {
      const stored = await store.rooms.byHandle(addr.handle);
      if (stored?.kind !== "phone") return this.refuseRoom(peer, "denied");
      if (stored.householdId === this.householdId) return this.joinLocal(peer, stored);
      householdId = stored.householdId;
    }
    if (this.busy(peer.key)) return this.refuseRoom(peer, "busy");
    const calls = this.env.calls;
    if (!calls) return this.refuseRoom(peer, "unreachable");
    // Only a person joins elsewhere (their app, or a phone that stands for them).
    const person =
      peer.kind === "user" ? peer.id : peer.kind === "device" ? personOf(peer) : undefined;
    const user = person && !person.startsWith("guest:") ? await store.getUser(person) : undefined;
    const account = user ? await store.getAccount(user.accountId) : undefined;
    if (!account) return this.refuseRoom(peer, "denied");
    const note = await fairUseProblem(this.env, account.id, "room");
    if (note) return this.refuseRoom(peer, "denied", undefined, note);
    const leg = newId("lg");
    const to = { host, ...(householdId ? { householdId } : {}) };
    this.legs.set(leg, {
      leg,
      peer,
      conn: new FedConn(this.env, to, leg),
      joinedAt: this.env.now(),
      payer: account.id,
    });
    this.confDirty = true;
    await calls.register(host, leg, this.householdId);
    // Over the network (or another hub's queue): not inside this hub's queue.
    void calls
      .roomJoin(host, { leg, from: partyOf(account), room: addr.handle }, this.householdId)
      .then(
        (r) => this.run(() => this.joinAnswered(leg, r)),
        () => this.run(() => this.joinAnswered(leg, { ok: false, reason: "unreachable" })),
      );
  }

  private async joinAnswered(leg: string, r: RoomJoinResult): Promise<void> {
    const l = this.legs.get(leg);
    if (!l || r.ok) return;
    this.legs.delete(leg);
    this.confDirty = true;
    this.refuseRoom(l.peer, r.reason, l.roomId, r.ok === false ? r.note : undefined);
  }

  /** A leg is over: meter it, and tell whoever needs to know. */
  private async endLeg(
    leg: RoomLeg,
    reason: RoomEndReason,
    tell: { tellRoom: boolean; tellPeer: boolean },
  ): Promise<void> {
    if (this.legs.get(leg.leg) !== leg) return;
    this.legs.delete(leg.leg);
    this.confDirty = true;
    const now = this.env.now();
    if (tell.tellRoom && leg.roomId) leg.conn.room({ t: "room.leave", roomId: leg.roomId });
    if (tell.tellPeer && leg.roomId) {
      leg.peer.conn.send({ t: "room.ended", roomId: leg.roomId, reason });
    }
    if (leg.payer && leg.roomId) {
      const minutes = Math.max(1, Math.ceil((now - leg.joinedAt) / 60_000));
      await this.env.store
        .addUsage(leg.payer, now, { roomMinutes: minutes })
        .catch((e) => this.env.log("warn", "room metering failed", { error: String(e) }));
    }
  }

  /** A message from the room's server for one of our people in it. */
  private async legSignal(leg: RoomLeg, msg: RoomSignalMsg): Promise<void> {
    if (msg.t === "room.state" && msg.recording) {
      // A room recorded on another server: this server may not take that for its people.
      if (this.env.refuseRecordedCalls && leg.conn.to.host !== LOCAL_HOST) {
        leg.roomId ??= msg.roomId;
        await this.endLeg(leg, "denied", { tellRoom: true, tellPeer: false });
        leg.peer.conn.send({
          t: "room.ended",
          roomId: msg.roomId,
          reason: "denied",
          note: REFUSES_RECORDING,
        });
        return;
      }
      // The recording is theirs: never pass a ticket on.
      msg = { ...msg, recording: { by: msg.recording.by } };
    }
    if (msg.t === "room.state") {
      if (!leg.roomId) {
        leg.roomId = msg.roomId;
        this.confDirty = true;
        // Their audio goes through our TURN, as for calls.
        leg.peer.conn.send({
          t: "rtc.config",
          callId: msg.roomId,
          iceServers: await this.env.iceServers(),
        });
      }
      leg.peer.conn.send(msg);
      return;
    }
    if (msg.t === "room.ended") {
      leg.roomId ??= msg.roomId;
      await this.endLeg(leg, msg.reason, { tellRoom: false, tellPeer: true });
      return;
    }
    if (
      msg.t === "room.media" ||
      msg.t === "room.idle" ||
      msg.t === "rtc.sdp" ||
      msg.t === "rtc.ice"
    ) {
      leg.peer.conn.send(msg);
    }
  }

  /**
   * One of our calls with someone elsewhere was merged into a room on their side: our person is
   * now in that room, through a leg under the call's id.
   */
  private async convertToLeg(room: Room, remote: Peer, roomId: string): Promise<void> {
    const local = room.caller === remote ? room.calleePeer : room.caller;
    room.cancelTimer?.();
    this.rooms.delete(room.id);
    this.roomsDirty = true;
    await this.closeBooks(room, "hangup");
    if (!local) return;
    const leg = remote.leg ?? room.id;
    const conn = remote.conn as FedConn;
    conn.useLeg(leg);
    const person = local.kind === "user" ? local.id : personOf(local);
    const payer =
      person && !person.startsWith("guest:")
        ? (await this.env.store.getUser(person))?.accountId
        : undefined;
    this.legs.set(leg, {
      leg,
      roomId,
      peer: local,
      conn,
      joinedAt: this.env.now(),
      ...(payer ? { payer } : {}),
    });
    this.confDirty = true;
    local.conn.send({ t: "rtc.config", callId: roomId, iceServers: await this.env.iceServers() });
    local.conn.send({
      t: "call.state",
      callId: room.id,
      state: "ended",
      reason: "hangup",
      merged: { roomId },
    });
  }

  /**
   * Someone elsewhere asks into one of this space's phone rooms. Default deny: a member of this
   * space (another household here), or — for a room open to connections — someone with an
   * active connection to its owner. Then lock and size; someone from another server counts
   * against the owner's fair use (their own server meters them too).
   */
  remoteRoomJoin(req: RemoteRoomJoin): Promise<RoomJoinResult> {
    return this.run(async (): Promise<RoomJoinResult> => {
      const { store } = this.env;
      const stored = await store.rooms.get(req.roomId);
      if (!stored || stored.householdId !== this.householdId || stored.kind !== "phone") {
        return { ok: false, reason: "denied" };
      }
      const hours = await this.hoursOf(stored);
      if (!roomOpenAt(hours, this.env.now()).open) {
        const opens = opensText(hours, this.env.now());
        return { ok: false, reason: "denied", note: opens ? `Closed. ${opens}` : "Closed" };
      }
      const inSpace =
        req.host === LOCAL_HOST && !!(await store.membership(req.from.id, this.householdId));
      let connected = false;
      if (stored.ownerAccount && stored.ownerAccount !== req.from.id) {
        const conn = await store.connections.findPeer(stored.ownerAccount, req.host, req.from);
        connected =
          conn?.state === "active" &&
          conn.peerAccount === req.from.id &&
          !(await store.connections.blocked(stored.ownerAccount, req.host, req.from));
      }
      const live = this.conf.get(stored.id);
      const media = live?.media ?? this.conf.mediaKind();
      const decision = roomAccess(
        {
          kind: stored.kind,
          access: stored.access,
          locked: live?.locked ?? stored.locked,
          size: live?.participants.size ?? 0,
          max: this.conf.maxSize(media),
        },
        { inSpace, connected },
      );
      if (!decision.ok) return { ok: false, reason: decision.reason };
      // A recorded room is announced to everyone in it: never with a server that can't.
      if (
        (await store.recordings.enabled(this.householdId)) &&
        !(await peerSupports(this.env, req.host, "recording-flag"))
      ) {
        return { ok: false, reason: "denied", note: RECORDED_ROOM_UNAVAILABLE };
      }
      const payer = req.host !== LOCAL_HOST ? (stored.ownerAccount ?? undefined) : undefined;
      const note = await fairUseProblem(this.env, payer, "room");
      if (note) return { ok: false, reason: "denied", note: note.slice(0, 200) };
      const address = this.roomAddress(stored);
      const room = this.conf.open({ ...stored, ...(address ? { address } : {}) });
      const peer = this.remotePeer({
        host: req.host,
        key: `fed:${req.host}:${req.from.id}`,
        label: req.from.name.slice(0, 24),
        peerHousehold: req.peerHousehold,
        leg: req.leg,
        address: `${req.from.handle}@${req.host || ownHost(this.env)}`,
      });
      await this.conf.admit(room, peer, {
        name: req.from.name,
        ...(req.host ? { remoteHost: req.host } : {}),
        ...(payer ? { payer } : {}),
      });
      return { ok: true, roomId: room.id, name: room.name };
    });
  }

  /** Tells the space's app sessions who's in a stored room now ("members see who's in"). */
  private announceRoom(room: LiveRoom): void {
    const people = [...room.participants.values()].map((p) => p.name).slice(0, 32);
    for (const set of this.apps.values()) {
      for (const app of set) app.conn.send({ t: "rooms.changed", roomId: room.id, people });
    }
  }

  roomPeople(): Promise<Record<string, string[]>> {
    return this.run(() => this.conf.people());
  }

  closeRoom(roomId: string): Promise<void> {
    return this.run(() => this.conf.close(roomId));
  }
}

const idOf = (key: string) => key.slice(4);

/** A connection's peer as an address, `handle@host` (lower case; this server's own host for a
 * connection here), as the call log and missed calls name remote callers. */
const addressOf = (env: ServerEnv, c: { peerHandle: string; peerHost: string }) =>
  `${c.peerHandle}@${c.peerHost || ownHost(env)}`.toLowerCase();

/** One entry of `config.missed`. */
type MissedItem = {
  from: string;
  callback?: true;
  kind?: "voicemail" | "call";
  at?: number;
  count?: number;
  id?: string;
};

/** Why a call in a space couldn't ring, and whose voicemail the caller may leave instead. */
type Refusal = { reason: EndReason; note?: string; vm?: VmTarget };

const NO_EXTENSION = NO_EXTENSION_NOTE;
/** Why a kids' phone's call to a public line is refused (on the phone, before anything else). */
const KIDS_NO_LINES = "Kids' phones can't call public lines";

/** How long a chime from a phone stays up (a notice). */
const CHIME_MINUTES = 15;
/** Why a kids' phone's call to an add-on is refused. */
const KIDS_NO_ADDONS = "Kids' phones can't call add-ons";
/** Test connection: how long an add-on has to answer `addon.test`. */
export const ADDON_TEST_TIMEOUT_MS = 5000;
/** Calls with an add-on stay between two: no 3-way, no transfer. */
const ADDON_ONE_TO_ONE = "a call with an add-on can't be merged or transferred";
const REMOTE_TRANSFER =
  "someone from another household or server can only be transferred inside a team or org space";
const REMOTE_TARGET =
  "transfer refused: only to people, phones, ring groups and extensions of this space";
const RECORDED_ROOM_UNAVAILABLE =
  "This space records its calls, and that server can't announce recordings yet";

/** Whom a transfer (or a dial as someone) reaches. */
type DialTarget =
  | { userId: string }
  | { deviceId: string }
  | { connectionId: string }
  | { extension: string }
  | { groupId: string };
/** A target inside this team/org space. */
type SpaceTarget = { userId: string } | { deviceId: string } | { groupId: string };

/** Room messages a participant may send (relayed from their server). */
function isRoomInbound(msg: RoomSignalMsg): msg is RoomInbound {
  return (
    msg.t === "room.leave" ||
    msg.t === "room.mute" ||
    msg.t === "room.remove" ||
    msg.t === "room.lock" ||
    msg.t === "room.talk" ||
    msg.t === "room.here" ||
    msg.t === "room.media" ||
    msg.t === "rtc.sdp" ||
    msg.t === "rtc.ice"
  );
}

/** A place a person rings besides the household that owns the call. */
type BranchPlan =
  | { kind: "space"; householdId: string; userId: string }
  | { kind: "away"; host: string; deviceId: string; guest: Party };

/** How a guest from another server is known in a Lounge session here. */
const guestKey = (g: LoungeGuest) => `guest:${g.host}:${g.id}`;

/** The check-in alert's sound: two soft tones (8 kHz 16-bit mono WAV, 0.8 s), so it plays anywhere. */
function checkinChime(): Uint8Array {
  const rate = 8000;
  const n = rate * 0.8;
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(at + i, t.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const hz = i < n / 2 ? 660 : 880;
    const env = Math.min(1, (i % (n / 2)) / 200, (n / 2 - (i % (n / 2))) / 400);
    v.setInt16(44 + i * 2, Math.round(9000 * env * Math.sin((2 * Math.PI * hz * i) / rate)), true);
  }
  return out;
}

/**
 * A phone's config within the 16 KiB message budget: with a hundred long labels it could
 * outgrow it, so the last pages of keys give way first (the phone still gets everything else).
 */
export function fitConfig(
  config: Extract<ServerToDevice, { t: "config" }>,
): Extract<ServerToDevice, { t: "config" }> {
  const size = (m: unknown) => new TextEncoder().encode(encode(m as ServerToDevice)).byteLength;
  let out = config;
  while (out.pages?.length && size(out) > MAX_MESSAGE_BYTES) {
    const pages = out.pages.slice(0, -1);
    const { pages: _p, ...rest } = out;
    out = pages.length ? { ...rest, pages } : rest;
  }
  return out;
}
