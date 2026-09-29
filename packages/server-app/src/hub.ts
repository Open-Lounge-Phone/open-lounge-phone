import {
  authorizeInbound,
  authorizeOutbound,
  isQuietAt,
  localClock,
  newRoom,
  nextQuietChange,
  type RoomEvent,
  type RoomState,
  resolveButton,
  roomStep,
} from "@openloungephone/core";
import {
  type Account,
  type Device,
  isRemoteContactId,
  LOCAL_HOST,
  newId,
  type User,
} from "@openloungephone/db";
import type { CallBody, FedSignal, Party } from "@openloungephone/federation";
import {
  type AppToServer,
  type DeviceToServer,
  type EndReason,
  type ServerToApp,
  type ServerToDevice,
  toBase64Url,
} from "@openloungephone/protocol";
import {
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type Conn,
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
  sendGuestProgress,
} from "./fedCalls.ts";
import { ownHost } from "./federation.ts";

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
  private chain: Promise<void> = Promise.resolve();
  private readonly env: ServerEnv;
  private readonly to: { host: string; householdId?: string };
  private readonly leg: string | undefined;

  constructor(env: ServerEnv, to: { host: string; householdId?: string }, leg?: string) {
    this.env = env;
    this.to = to;
    this.leg = leg;
  }

  send(msg: ServerToDevice | ServerToApp): void {
    if (msg.t !== "call.state" && msg.t !== "rtc.sdp" && msg.t !== "rtc.ice") return;
    if (msg.t === "call.state" && msg.state === "ringing") return;
    const calls = this.env.calls;
    if (!calls) return;
    // The far end knows this call by its own id (a leg of a relayed call).
    const signal = (this.leg ? { ...msg, callId: this.leg } : msg) as FedSignal;
    this.chain = this.chain
      .then(() => calls.signal(this.to, signal))
      .catch((e) => this.env.log("warn", "federated signal failed", { error: String(e) }));
  }

  close(): void {}
}

const partyOf = (a: Account): Party => ({ handle: a.handle, id: a.id, name: a.name });

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
  caller: Peer;
  /** Known once the callee is a device (immediately) or a user answers from one session. */
  calleePeer?: Peer;
  cancelTimer?: () => void;
}

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

  readonly householdId: string;
  private readonly env: ServerEnv;

  constructor(householdId: string, env: ServerEnv) {
    this.householdId = householdId;
    this.env = env;
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

  private remember(peer: Peer): void {
    peer.conn.remember?.({ kind: "peer", peer: infoOf(peer) });
  }

  private flushRooms(): void {
    if (!this.roomsDirty || !this.env.saveRooms) return;
    this.roomsDirty = false;
    this.env.saveRooms(this.householdId, this.snapshotRooms());
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
        caller: r.caller.session,
        ...(r.calleePeer ? { callee: r.calleePeer.session } : {}),
        ...(remotes.length ? { remotes: remotes.map(infoOf) } : {}),
      };
    });
  }

  /**
   * Rebuilds live state after the host slept: re-registers authenticated connections and the
   * rooms that referenced them. Sends nothing. Returns the peers in input order.
   */
  restore(entries: { info: PeerInfo; conn: Conn }[], rooms: RoomSnapshot[]): Peer[] {
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
        ...(snap.payer ? { payer: snap.payer } : {}),
        ...(snap.activeAt !== undefined ? { activeAt: snap.activeAt } : {}),
        ...(snap.startedAt !== undefined ? { startedAt: snap.startedAt } : {}),
        ...(snap.answered ? { answered: true } : {}),
        caller,
        ...(calleePeer ? { calleePeer } : {}),
      });
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
    for (const room of [...this.rooms.values()]) {
      if (room.caller === peer) {
        void this.apply(room, { type: "hangup", by: room.state.caller });
      } else if (room.calleePeer === peer) {
        void this.apply(room, { type: "hangup", by: room.state.callee });
      } else if (!room.calleePeer && this.ringTargets(room).length === 0) {
        // The last session or phone that was ringing for the callee went away.
        void this.apply(room, { type: "timeout" });
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
          return;
        }
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
        case "rtc.sdp":
        case "rtc.ice":
          return this.callMessage(peer, msg);
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
        case "rtc.sdp":
        case "rtc.ice":
          return this.callMessage(peer, msg);
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

  /** A removed phone is told it's no longer paired (it then shows a new pairing code). */
  forgetDevice(deviceId: string): Promise<void> {
    return this.run(() => {
      const peer = this.devices.get(deviceId);
      if (!peer) return;
      peer.conn.send({ t: "error", code: "unauthorized", message: "this phone was removed" });
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
      await this.scheduleWake();
    });
  }

  // --- dialing ----------------------------------------------------------------

  private busy(key: string): boolean {
    for (const r of this.rooms.values()) {
      if (r.state.caller === key || r.state.callee === key) return true;
    }
    return false;
  }

  /** Reports a call that never got a room (denied, busy, unreachable) to the caller. */
  private refuse(peer: Peer, reason: EndReason, note?: string): void {
    peer.conn.send({
      t: "call.state",
      callId: newId("call"),
      state: "ended",
      reason,
      ...(note ? { note } : {}),
    });
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
    if (this.busy(device.key)) return;
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
    const decision = authorizeOutbound(contact, {
      quietHours: schedule,
      now: new Date(this.env.now()),
    });
    if (decision.decision === "deny" || !contact) return this.refuse(device, "denied");
    if (isRemoteContactId(contact.id)) return this.remoteContactDial(device, contact.id);
    const targets = this.reachable(contact.id, device);
    if (!targets.length) return this.refuse(device, "unreachable");
    if (this.busy(userKey(contact.id))) return this.refuse(device, "busy");

    const room = this.openRoom(device, userKey(contact.id));
    room.payer = allowance.payer;
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    for (const t of targets) {
      t.conn.send({ t: "call.ringing", callId: room.id, from: { label: device.label } });
    }
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
    if (decision.decision === "voicemail") return this.refuse(user, "voicemail");
    const peer = this.devices.get(deviceId);
    if (!peer) return this.refuse(user, "unreachable");
    if (this.busy(peer.key) || this.busy(user.key) || peer.hook === "up") {
      return this.refuse(user, "busy");
    }
    const allowance = await this.allowance(user, as);
    if (allowance.note) return this.refuse(user, "denied", allowance.note);

    const room = this.openRoom(user, peer.key);
    room.payer = allowance.payer;
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
    const targets = this.reachable(userId);
    if (!targets.length) return this.refuse(caller, "unreachable");
    const available = (await this.env.store.availability(this.householdId)).get(userId) ?? true;
    if (!available) return this.refuse(caller, "unavailable");
    if (this.busy(caller.key) || this.busy(userKey(userId))) return this.refuse(caller, "busy");
    const allowance = await this.allowance(caller, as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);

    const room = this.openRoom(caller, userKey(userId));
    room.payer = allowance.payer;
    caller.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    for (const t of targets) {
      t.conn.send({ t: "call.ringing", callId: room.id, from: { label: as.label } });
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
    this.env.onPresence?.(this.householdId, userId, msg.online, available);
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

  private openRoom(caller: Peer, calleeKey: string, id = newId("call")): Room {
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
      RING_TIMEOUT_MS,
    );
    return room;
  }

  // --- in-call ----------------------------------------------------------------

  private partyOf(room: Room, peer: Peer): "caller" | "callee" | undefined {
    if (room.caller === peer) return "caller";
    if (room.calleePeer === peer) return "callee";
    if (!room.calleePeer && this.answersFor(peer, room.state.callee)) return "callee";
    return undefined;
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
    const key = room.state.callee;
    if (!key.startsWith("usr:")) return [];
    const userId = idOf(key);
    const phones = [...this.devices.values()].filter((d) => personOf(d) === userId);
    return [...(this.apps.get(userId) ?? []), ...phones];
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
        await this.logCall(room, r.state.reason ?? "hangup").catch((e) =>
          this.env.log("warn", "call log failed", { error: String(e) }),
        );
        if (room.payer && room.activeAt !== undefined) {
          // Metered at the end, rounded up to whole minutes; enforced only when calls start.
          const minutes = Math.ceil((this.env.now() - room.activeAt) / 60_000);
          await this.env.store.addUsage(room.payer, this.env.now(), { callMinutes: minutes });
        }
        const reason = r.state.reason ?? "hangup";
        const ringing = this.ringTargets(room);
        for (const p of [...both, ...ringing]) {
          p.conn.send({ t: "call.state", callId: room.id, state: "ended", reason });
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

  // --- config & status ----------------------------------------------------------

  private async sendConfig(peer: DevicePeer, force: boolean): Promise<void> {
    const { store } = this.env;
    if (peer.lounge) {
      // Only the person using it: their speed-dial. Nobody there: nothing at all.
      if (!force) return;
      const session = peer.lounge.session;
      const dir = session ? await this.sessionDirectory(session) : new Map();
      peer.conn.send({
        t: "config",
        buttons: [...dir].map(([index, e]) => ({ index, label: e.label })),
        quiet: false,
      });
      return;
    }
    const [buttons, contacts, schedule, missed] = await Promise.all([
      store.listButtons(peer.id),
      store.listContacts(peer.id),
      this.scheduleFor(peer),
      store.unheardFrom(peer.id),
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
      quiet,
      ...(quietUntil ? { quietUntil } : {}),
      ...(missed.length ? { missed: missed.map((from) => ({ from: from.slice(0, 24) })) } : {}),
    });
  }

  /**
   * The hub's one alarm: the next quiet-hours change (while phones are connected) or the end of
   * a disconnected Lounge phone's reconnect grace, whichever is first. Sleeping until then
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
    const [firstOffline] = await store.offlineLoungeSessions(this.householdId);
    if (firstOffline?.offlineAt != null) {
      const graceEnd = firstOffline.offlineAt + LOUNGE_RECONNECT_GRACE_MS;
      at = at === undefined ? graceEnd : Math.min(at, graceEnd);
    }
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
  }

  /** Restarts the idle clock: it runs only while the phone is hung up and not in a call. */
  private async touchIdle(device: DevicePeer): Promise<void> {
    const t = this.timers(device.id);
    t.idle?.();
    t.idle = undefined;
    const session = device.lounge?.session;
    if (!session || device.hook === "up" || this.busy(device.key)) return;
    const minutes = await this.env.store.loungeIdleMinutes(this.householdId);
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

  private async loungeDial(device: DevicePeer, index: number): Promise<void> {
    const session = device.lounge?.session;
    if (!session) return this.refuse(device, "denied");
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
      const other = await this.describe(side.other, side.otherKey);
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
    return this.dialRemote(caller, {
      as,
      host: conn.peerHost,
      key: `fed:${conn.peerHost}:${conn.peerAccount}`,
      label: (conn.peerName || conn.peerHandle).slice(0, 24),
      peerHousehold,
      body: {
        from: partyOf(account),
        to: { kind: "person", handle: conn.peerHandle },
      },
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
      as?: { id: string };
    },
  ): Promise<void> {
    const calls = this.env.calls;
    if (!calls) return this.refuse(caller, "unreachable");
    if (this.busy(caller.key) || this.busy(target.key)) return this.refuse(caller, "busy");
    const allowance = await this.allowance(caller, target.as);
    if (allowance.note) return this.refuse(caller, "denied", allowance.note);
    const to = target.body.to;
    const host = target.host || ownHost(this.env);
    const remote = this.remotePeer({
      ...target,
      address: to.kind === "person" ? `${to.handle}@${host}` : `device:${to.deviceId}@${host}`,
    });
    const room = this.openRoom(caller, remote.key);
    room.payer = allowance.payer;
    room.calleePeer = remote;
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
        if (!targets.length) return end("unreachable");
        const available = (await store.availability(this.householdId)).get(userId) ?? true;
        if (!available) return end("unavailable");
        if (this.busy(userKey(userId))) return end("busy");
        const room = this.openRoom(remote, userKey(userId), req.callId);
        for (const t of targets) {
          t.conn.send({ t: "call.ringing", callId: room.id, from: { label: req.label } });
        }
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
      const room = this.openRoom(remote, peer.key, req.callId);
      room.calleePeer = peer;
      this.roomsDirty = true;
      peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: contact.label } });
      return { state: "ringing" };
    });
  }

  /** Signaling from the far end of a call with another household (host '') or server. */
  remoteSignal(host: string, msg: FedSignal): Promise<void> {
    return this.run(async () => {
      let room: Room | undefined;
      let remote: Peer | undefined;
      for (const r of this.rooms.values()) {
        remote = [r.caller, r.calleePeer].find(
          (p) => p?.kind === "remote" && p.host === host && (p.leg ?? r.id) === msg.callId,
        );
        if (remote) {
          room = r;
          break;
        }
      }
      if (!room || !remote) return;
      const party = remote === room.caller ? "caller" : "callee";
      if (msg.t === "call.state") {
        if (msg.state === "ended") {
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
    const room = this.openRoom(device, remote.key);
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
        ? this.run(() => this.apply(room, { type: "end", reason: r.reason }))
        : undefined,
    );
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
      });
      if (this.busy(caller.key)) return { state: "ended", reason: "busy" };
      const account = (await store.getAccount(conn.accountId)) as Account;
      if (await fairUseProblem(this.env, account.id, "call")) {
        return { state: "ended", reason: "denied" };
      }
      let peerHousehold: string | undefined;
      if (conn.peerHost === LOCAL_HOST) {
        const here = await store.membership(conn.peerAccount, this.householdId);
        if (here) {
          // Someone in this household: ring them here directly.
          const targets = this.reachable(here.id);
          if (!targets.length) return { state: "ended", reason: "unreachable" };
          if (this.busy(userKey(here.id))) return { state: "ended", reason: "busy" };
          const room = this.openRoom(caller, userKey(here.id));
          room.payer = account.id;
          await calls.register(req.host, req.callId, this.householdId);
          for (const t of targets) {
            t.conn.send({
              t: "call.ringing",
              callId: room.id,
              from: { label: account.name.slice(0, 24) },
            });
          }
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
      if (this.busy(callee.key)) return { state: "ended", reason: "busy" };
      const room = this.openRoom(caller, callee.key);
      room.payer = account.id;
      room.calleePeer = callee;
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
}

const idOf = (key: string) => key.slice(4);

/** How a guest from another server is known in a Lounge session here. */
const guestKey = (g: LoungeGuest) => `guest:${g.host}:${g.id}`;
