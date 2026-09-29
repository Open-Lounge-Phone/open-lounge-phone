import {
  afterHoursAction,
  authorizeInbound,
  authorizeOutbound,
  CLOSED_NOTE,
  type Contact,
  controlCheck,
  effectiveHours,
  goesToVoicemail,
  huntSteps,
  isOpen,
  isQuietAt,
  localClock,
  loungeDayEnd,
  MAX_RING_SECONDS,
  type Meeting,
  mayConnect,
  NO_EXTENSION_NOTE,
  newRoom,
  nextQuietChange,
  nextRoundRobin,
  type PartyCall,
  type RoomEvent,
  type RoomState,
  resolveButton,
  roomAccess,
  roomStep,
} from "@openloungephone/core";
import {
  type Account,
  type Device,
  deviceMode,
  type HouseLineKey,
  isRemoteContactId,
  isRoomContactId,
  LOCAL_HOST,
  newId,
  type Room as StoredRoom,
  type User,
  type VoicemailOwner,
} from "@openloungephone/db";
import {
  type CallBody,
  type FedSignal,
  type Party,
  parseAddress,
  type RoomJoinResult,
  type RoomSignalMsg,
} from "@openloungephone/federation";
import {
  type AppToServer,
  type DeviceToServer,
  type EndReason,
  type RoomEndReason,
  type ServerToApp,
  type ServerToDevice,
  type TransferTarget,
  toBase64Url,
  type VoicemailOffer,
} from "@openloungephone/protocol";
import {
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type ConferenceSnapshot,
  type Conn,
  type HuntState,
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
  placeGuestDial,
  primaryHousehold,
  type RelayDial,
  type RemoteRing,
  type RemoteRoomJoin,
  sendGuestProgress,
} from "./fedCalls.ts";
import { ownHost } from "./federation.ts";
import { type LiveRoom, LiveRooms, type RoomInbound } from "./liveRooms.ts";
import { SWEEP_EVERY_MS, sweepSpace } from "./timeline.ts";
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

  constructor(
    env: ServerEnv,
    to: { host: string; householdId?: string },
    leg?: string,
    offers = false,
  ) {
    this.env = env;
    this.to = to;
    this.leg = leg;
    this.offers = offers;
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
    if (msg.t !== "call.state" && msg.t !== "rtc.sdp" && msg.t !== "rtc.ice") return;
    if (msg.t === "call.state" && msg.state === "ringing") return;
    // A voicemail offer never crosses to the other server, except to a Lounge phone there where
    // one of our accounts is a guest (it relays the offer to the phone; see `remoteSignal`).
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
   * `address`: a guest's speed-dial entry, dialed through the guest's own server.
   */
  kind: "user" | "device" | "connection" | "address";
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
}

/** Someone signed in at another Lounge phone and open to chat ("who's here"). */
type Here = { name: string; where: string };

const deviceKey = (id: string) => `dev:${id}`;
const userKey = (id: string) => `usr:${id}`;

/**
 * All live connections and calls for one household. Calls never cross households, so this is the
 * unit of coordination: an in-process object when self-hosting, one Durable Object on Cloudflare.
 *
 * Signaling is peer-to-peer: the hub relays `rtc.*` between the two parties and the party that
 * placed the call sends the SDP offer.
 */
export class HouseholdHub {
  private readonly devices = new Map<string, DevicePeer>();
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
        key: info.kind === "device" ? deviceKey(info.id) : userKey(info.id),
        conn,
      };
      if (peer.kind === "device") {
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
        caller,
        ...(calleePeer ? { calleePeer } : {}),
      });
    }
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

  connectDevice(device: Device, conn: Conn): Promise<Peer> {
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
        label: device.name,
        conn,
        guardian: false,
        hook: "down",
        ...(device.ownerUserId ? { owner: device.ownerUserId } : {}),
        ...(device.kind === "lounge" ? { lounge: { nonce: "", nonceExpiresAt: 0 } } : {}),
      };
      // Back within the grace period: the session carries on (a replaced socket hands it over).
      const resumed = peer.lounge ? await this.resumeLounge(peer, old) : undefined;
      const wasOnline = device.ownerUserId ? this.userOnline(device.ownerUserId) : true;
      this.devices.set(device.id, peer);
      if (resumed) {
        conn.send({ t: "lounge.session", name: resumed.name, openToChat: resumed.openToChat });
      }
      await this.sendConfig(peer, true);
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
      return peer;
    });
  }

  connectApp(user: User, conn: Conn): Promise<Peer> {
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
      };
      const set = this.apps.get(user.id) ?? new Set<Peer>();
      const cameOnline = set.size === 0 && !this.userOnline(user.id);
      this.apps.set(user.id, set);
      set.add(peer);
      this.remember(peer);
      conn.send({ t: "app.ready", userId: user.id });
      // Everyone's presence for this session, then tell the others this person is online.
      const available = await this.env.store.availability(this.householdId);
      for (const [userId, avail] of available) {
        if (userId === user.id) continue;
        conn.send(this.memberMessage(userId, avail));
      }
      if (cameOnline) this.broadcastMember(user.id, available.get(user.id) ?? true);
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
      } else if (!room.calleePeer && this.ringTargets(room).length === 0) {
        // The last session or phone that was ringing for the callee went away (a ring group
        // moves on to its next step).
        if (room.hunt) void this.huntNext(room);
        else void this.apply(room, { type: "timeout" });
      }
    }
  }

  isOnline(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  // --- inbound messages -----------------------------------------------------

  handleDevice(peer: Peer, msg: DeviceToServer): Promise<void> {
    return this.run(async () => {
      const device = this.devices.get(peer.id);
      if (device !== peer) return; // stale connection
      switch (msg.t) {
        case "hook":
          device.hook = msg.state;
          this.remember(device);
          if (device.lounge) await this.touchIdle(device);
          return;
        case "button":
          return this.deviceDial(device, msg.index);
        case "call.extension":
          return this.extensionDial(device, msg.number);
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
          return;
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
      const peer = this.devices.get(deviceId);
      if (!peer) return;
      peer.conn.send({ t: "wipe", reason: "removed" });
      this.dropPeer(peer);
      peer.conn.close(CloseCode.unauthorized, "removed");
    });
  }

  /** Re-send config to a device after guardians change settings (incl. quiet hours). */
  refreshDevice(deviceId: string): Promise<void> {
    return this.run(async () => {
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
        peer.label = device.name;
        if (device.ownerUserId) peer.owner = device.ownerUserId;
        else delete peer.owner;
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

  /** Called by hosts that implement `wakeAt`, at the requested time. */
  wake(): Promise<void> {
    return this.run(async () => {
      for (const d of this.devices.values()) await this.sendConfig(d, false);
      await this.expireOfflineLounges();
      await this.endDayEndSessions();
      await this.env.flushPresence?.(this.householdId);
      await this.conf.sweepIdle(this.env.now());
      await this.scheduleWake();
    });
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
    if (this.busy(userKey(contact.id))) return this.refuse(device, "busy", undefined, vm);

    const room = this.openRoom(
      device,
      userKey(contact.id),
      undefined,
      await this.personRingMs(contact.id),
    );
    room.payer = allowance.payer;
    if (vm) room.vm = vm;
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(room, targets, plans, device.label);
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
    if (!this.canDial(user)) return this.refuse(user, "busy");
    if (this.busy(peer.key) || peer.hook === "up") {
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
    peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: contact.label } });
  }

  /**
   * Grown-up, app-to-app call between two members of this server. Refused unless the callee
   * has an open session and is taking calls; never rings a busy person.
   */
  private async userDial(
    caller: Peer,
    userId: string,
    as: { id: string; label: string } = caller,
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
    if (!this.canDial(caller)) return this.refuse(caller, "busy");
    const targets = this.reachable(userId);
    const plans = await this.branchesFor(userId);
    if (!targets.length && !plans.length) return this.refuse(caller, "unreachable", undefined, vm);
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    if (!available) return this.refuse(caller, "unavailable", undefined, vm);
    if (this.busy(userKey(userId))) return this.refuse(caller, "busy", undefined, vm);
    const allowance = await this.allowance(caller, as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);

    const room = this.openRoom(caller, userKey(userId), undefined, await this.personRingMs(userId));
    room.payer = allowance.payer;
    if (vm) room.vm = vm;
    caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    this.ringAll(room, targets, plans, as.label);
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
    for (const t of targets) {
      t.conn.send({ t: "call.ringing", callId: room.id, from: { label } });
    }
    const calls = this.env.calls;
    if (!calls) return;
    for (const plan of plans) {
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
    const room = this.rooms.get(msg.callId);
    const party = room && this.partyOf(room, peer);
    if (!room || !party) {
      // Late messages for a finished call are normal; tell the sender it is over.
      if (msg.t !== "rtc.ice") {
        peer.conn.send({ t: "call.state", callId: msg.callId, state: "ended", reason: "hangup" });
      }
      return;
    }

    if (msg.t === "call.answer") {
      if (party !== "callee" || room.state.phase !== "ringing") return;
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
        room.cancelTimer?.();
        room.cancelTimer = this.env.setTimer(
          () => void this.run(() => this.apply(room, { type: "timeout" })),
          CONNECT_TIMEOUT_MS,
        );
        const iceServers = await this.env.iceServers();
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
        return;
      case "ended": {
        room.cancelTimer?.();
        this.rooms.delete(room.id);
        for (const [k, v] of this.handoffs) if (v === room.id) this.handoffs.delete(k);
        await this.logCall(room, r.state.reason ?? "hangup").catch((e) =>
          this.env.log("warn", "call log failed", { error: String(e) }),
        );
        this.maybeSweep();
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
            ...(voicemail && p === room.caller ? { voicemail } : {}),
          });
        }
        for (const p of both) {
          const d = this.devices.get(p.id);
          if (d === p && d.lounge) await this.touchIdle(d);
        }
        return;
      }
      default:
        return;
    }
  }

  // --- greetings recorded on the phone ------------------------------------------------

  /**
   * Whose greeting a phone records from MENU → Voicemail: its owner's (a person's own phone) or
   * its own (a kids' phone, if its guardians let the child). Lounge phones have none.
   */
  private async phoneGreeting(
    device: DevicePeer,
  ): Promise<{ owner: VoicemailOwner; canRecord: boolean } | undefined> {
    if (device.lounge) return undefined;
    if (device.owner) {
      const user = await this.env.store.getUser(device.owner);
      return user ? { owner: { accountId: user.accountId }, canRecord: true } : undefined;
    }
    const owner = { deviceId: device.id };
    const prefs = await this.env.store.voicemailPrefs(owner);
    return { owner, canRecord: prefs.childGreeting };
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
        });
        return;
      }
      const dir = await this.sessionDirectory(session);
      const extensions = !session.guest && (await this.hasExtensions());
      peer.conn.send({
        t: "config",
        buttons: [...dir].map(([index, e]) => ({ index, label: e.label })),
        quiet: false,
        ...(owner ? { owner } : {}),
        ...(extensions ? { extensions: true } : {}),
      });
      return;
    }
    const [buttons, contacts, schedule, missed, greeting, extensions] = await Promise.all([
      store.listButtons(peer.id),
      store.listContacts(peer.id),
      this.scheduleFor(peer),
      store.unheardFrom(peer.id, 8, peer.owner),
      this.phoneGreeting(peer),
      peer.owner ? this.hasExtensions() : false,
    ]);
    const now = new Date(this.env.now());
    const quiet = isQuietAt(schedule, now);
    if (!force && quiet === peer.lastQuiet) return;
    if (quiet !== peer.lastQuiet) {
      peer.lastQuiet = quiet;
      this.remember(peer);
    }
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const mapped = [...buttons]
      .map(([index, userId]) => ({ index, contact: byId.get(userId) }))
      .filter((b) => b.contact?.deviceCanCall)
      .map((b) => ({ index: b.index, label: b.contact?.label ?? "" }));
    const end = quiet ? nextQuietChange(schedule, now) : undefined;
    let quietUntil: string | undefined;
    if (end) {
      const { minutes } = localClock(end, schedule.timeZone);
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      quietUntil = `${hh}:${String(minutes % 60).padStart(2, "0")}`;
    }
    peer.conn.send({
      t: "config",
      buttons: mapped,
      ...(owner ? { owner } : {}),
      quiet,
      ...(quietUntil ? { quietUntil } : {}),
      ...(missed.length ? { missed: missed.map((from) => ({ from: from.slice(0, 24) })) } : {}),
      ...(greeting
        ? {
            greeting: {
              kind: (await greetingOf(this.env, greeting.owner, false)).kind,
              canRecord: greeting.canRecord,
            },
          }
        : {}),
      ...(extensions ? { extensions: true } : {}),
    });
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
    const mode = peer.lounge ? "lounge" : peer.owner ? "personal" : "kids";
    const person = peer.owner ? (await store.getUser(peer.owner))?.name : undefined;
    return {
      mode: mode as "kids" | "personal" | "lounge",
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
      for (const [index, id] of buttons) {
        const c = byId.get(id);
        if (!c?.deviceCanCall || id === userId || index >= 10) continue;
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
    for (const [i, e] of entries.slice(0, 10).entries()) out.set(i, e);
    return out;
  }

  /** Who a party is, from the other side's point of view (for the call log). */
  private async describe(
    peer: Peer | undefined,
    key: string,
  ): Promise<{ peer: string; label: string }> {
    if (peer?.kind === "remote") {
      return { peer: peer.address ?? (peer.host || ownHost(this.env)), label: peer.label };
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
      });
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
        info.loungeRelay === true,
      ),
    };
  }

  /** Calls someone `as` is connected with in another household or on another server. */
  private async connectionDial(
    caller: Peer,
    connectionId: string,
    as: { id: string; label: string } = caller,
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
      if (here) return this.userDial(caller, here.id, as);
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
    if (!this.canDial(caller)) return this.refuse(caller, "busy");
    if (this.busy(target.key)) return this.refuse(caller, "busy", undefined, vm);
    const allowance = await this.allowance(caller, target.as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);
    const to = target.body.to;
    const host = target.host || ownHost(this.env);
    const remote = this.remotePeer({
      ...target,
      address: to.kind === "person" ? `${to.handle}@${host}` : `device:${to.deviceId}@${host}`,
    });
    // The far end decides when it stops ringing (its own ring time); this is only a backstop.
    const room = this.openRoom(caller, remote.key, undefined, MAX_RING_SECONDS * 1000 + 5_000);
    room.payer = allowance.payer;
    room.calleePeer = remote;
    if (vm) room.vm = vm;
    this.roomsDirty = true;
    await calls.register(target.host, room.id, this.householdId);
    caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    // Placement goes over the network: not inside the hub's queue.
    const body: CallBody = { ...target.body, callId: room.id };
    void calls.place(target.host, body, this.householdId).then(
      (r) =>
        r.state === "ended"
          ? this.run(() => this.apply(room, { type: "end", reason: r.reason }))
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
      });
      if (req.target.kind === "person") {
        const userId = req.target.userId;
        const targets = this.reachable(userId);
        const plans = req.noBranches ? [] : await this.branchesFor(userId);
        if (!targets.length && !plans.length) return end("unreachable");
        const available = (await store.availability(this.householdId)).get(userId) ?? true;
        if (!available) return end("unavailable");
        if (this.busy(userKey(userId))) return end("busy");
        const room = this.openRoom(
          remote,
          userKey(userId),
          req.callId,
          await this.personRingMs(userId),
        );
        this.ringAll(room, targets, plans, req.label);
        return { state: "ringing" };
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
      if (this.busy(peer.key) || peer.hook === "up") return end("busy");
      const room = this.openRoom(
        remote,
        peer.key,
        req.callId,
        await this.ringMs({ deviceId: device.id }),
      );
      room.calleePeer = peer;
      this.roomsDirty = true;
      peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: contact.label } });
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
      if (msg.t === "call.state") {
        if (msg.state === "ended" && msg.merged) {
          return this.convertToLeg(room, remote, msg.merged.roomId);
        }
        if (msg.state === "ended" && msg.transfer) return this.repoint(room, remote, msg.transfer);
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
          if (msg.voicemail && party === "callee") this.relayOffer(room, host, msg.voicemail);
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
        ? this.run(() => {
            if (r.voicemail) this.relayOffer(room, guest.host, r.voicemail);
            return this.apply(room, { type: "end", reason: r.reason });
          })
        : undefined,
    );
  }

  /**
   * A guest's call from our Lounge phone went unanswered and their server offered voicemail:
   * the phone gets an offer of ours that forwards to theirs (their server delivers it as them).
   */
  private relayOffer(room: Room, host: string, offer: VoicemailOffer): void {
    const phone = room.caller;
    const guest = phone.kind === "device" ? phone.lounge?.session?.guest : undefined;
    if (!guest || guest.host !== host || room.calleePeer?.host !== host) return;
    room.vm = {
      target: { kind: "relay", host, ticket: offer.ticket, name: offer.name },
      from: { label: guest.name.slice(0, 24), address: `device:${phone.id}` },
    };
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
    if (!this.canDial(caller)) return this.refuse(caller, "busy");
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
    if (!target || target.householdId !== this.householdId || deviceMode(target) === "kids") {
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
    opts: { except?: string; forwarded?: boolean; id?: string },
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
        return this.openToGroup(caller, action.groupId, label, { ...opts, forwarded: true });
      }
      if (action.kind === "user" && action.userId !== opts.except) {
        const r = await this.openToUser(caller, action.userId, label, opts.id);
        return "state" in r ? r : { ...r, note: CLOSED_NOTE };
      }
      return { reason: "voicemail", note: CLOSED_NOTE, vm: box };
    }
    const availability = await store.availability(this.householdId);
    const steps = huntSteps(
      group.strategy,
      group.members,
      (u) =>
        u !== opts.except &&
        (availability.get(u) ?? true) &&
        !this.busy(userKey(u)) &&
        !this.ringingForGroup(u) &&
        this.reachable(u, caller).length > 0,
      group.nextIndex,
    );
    const first = steps[0];
    if (!first) return { reason: "unavailable", vm: box };
    if (group.strategy === "round_robin") {
      await store.workplace.setNextIndex(group.id, nextRoundRobin(group.members, first[0] ?? ""));
    }
    const stepMs = group.ringSeconds * 1000;
    const room = this.openRoom(caller, `hg:${group.id}`, opts.id, stepMs);
    room.hunt = { groupId: group.id, name: group.name, steps, step: 0, stepMs, label };
    room.group = first;
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
    if (room.state.phase !== "ringing") return;
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
  private async hold(peer: Peer, callId: string, hold: boolean): Promise<void> {
    const room = this.rooms.get(callId);
    const other = room && this.otherParty(room, peer);
    if (!room || !other) return this.refuseControl(peer, "no such call");
    const check = controlCheck(this.partyCalls(peer), { type: "hold", callId, hold });
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
          if (!isRemoteContactId(c.id) && !isRoomContactId(c.id)) allowed.add(userKey(c.id));
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
    if (!(await this.kidsMayMeet([peer, b, c]))) {
      return this.refuseControl(peer, "a kids' phone can only be with people on its list");
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
    if (!id || isRoomContactId(id)) return undefined;
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
      return d?.householdId === this.householdId && deviceMode(d) !== "kids"
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
  private successor(far: Peer, leg?: string): Peer {
    const next = this.remotePeer({
      host: far.host ?? LOCAL_HOST,
      key: far.key,
      label: far.label,
      peerHousehold: far.peerHousehold,
      ...(leg ? { leg } : {}),
      ...(far.address ? { address: far.address } : {}),
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
    const target = await this.spaceTarget(peer, to);
    const self = await this.callingAs(peer);
    if (!target || ("userId" in target && target.userId === self?.id)) {
      return this.refuseControl(peer, REMOTE_TARGET);
    }
    const id = newId("call");
    const far = this.successor(other);
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
    const far = this.successor(remote, t.callId);
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

/** Why a call in a space couldn't ring, and whose voicemail the caller may leave instead. */
type Refusal = { reason: EndReason; note?: string; vm?: VmTarget };

const NO_EXTENSION = NO_EXTENSION_NOTE;
const REMOTE_TRANSFER =
  "someone from another household or server can only be transferred inside a team or org space";
const REMOTE_TARGET =
  "transfer refused: only to people, phones, ring groups and extensions of this space";

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
