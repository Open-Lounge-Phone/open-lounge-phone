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
import { type Device, newId, type User } from "@openloungephone/db";
import {
  type AppToServer,
  type DeviceToServer,
  type EndReason,
  type ServerToApp,
  toBase64Url,
} from "@openloungephone/protocol";
import {
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type Conn,
  LOUNGE_NONCE_TTL_MS,
  LOUNGE_PROOF_MS,
  LOUNGE_RECONNECT_GRACE_MS,
  type PeerInfo,
  RING_TIMEOUT_MS,
  type RoomSnapshot,
  type ServerEnv,
} from "./env.ts";

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

type LoungeEndReason = "logout" | "left" | "idle" | "replaced" | "removed" | "offline";
type LoungeFail = "expired" | "wrong_key" | "timeout" | "busy" | "not_found";

/** Something on a Lounge phone's speed-dial while a person uses it. */
interface LoungeEntry {
  kind: "user" | "device";
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
    return [...this.rooms.values()].map((r) => ({
      id: r.id,
      state: r.state,
      caller: r.caller.session,
      ...(r.calleePeer ? { callee: r.calleePeer.session } : {}),
    }));
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
      const caller = bySession.get(snap.caller);
      if (!caller || snap.state.phase === "ended") continue;
      const calleePeer = snap.callee ? bySession.get(snap.callee) : undefined;
      if (snap.callee && !calleePeer) continue;
      this.rooms.set(snap.id, {
        id: snap.id,
        state: snap.state,
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
      const session = replaced ? undefined : peer.lounge?.session;
      const now = this.env.now();
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
  private refuse(peer: Peer, reason: EndReason): void {
    peer.conn.send({ t: "call.state", callId: newId("call"), state: "ended", reason });
  }

  private async deviceDial(device: DevicePeer, index: number): Promise<void> {
    if (this.busy(device.key)) return;
    if (device.lounge) return this.loungeDial(device, index);
    const { store } = this.env;
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
    const targets = this.reachable(contact.id, device);
    if (!targets.length) return this.refuse(device, "unreachable");
    if (this.busy(userKey(contact.id))) return this.refuse(device, "busy");

    const room = this.openRoom(device, userKey(contact.id));
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

    const room = this.openRoom(user, peer.key);
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

    const room = this.openRoom(caller, userKey(userId));
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

  private openRoom(caller: Peer, calleeKey: string): Room {
    const room: Room = { id: newId("call"), state: newRoom(caller.key, calleeKey), caller };
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
        for (const p of both) p.conn.send({ t: "call.state", callId: room.id, state: "active" });
        return;
      case "ended": {
        room.cancelTimer?.();
        this.rooms.delete(room.id);
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
      const dir = session ? await this.loungeDirectory(session.userId) : new Map();
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
              userId: peer.lounge.session.userId,
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
      this.tellUser(row.userId, row.deviceId, "offline");
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
    if (earlier)
      this.appSession(earlier.app)?.conn.send({
        t: "lounge.progress",
        deviceId,
        step: "failed",
        reason: "timeout",
      });
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
    this.appSession(challenge.app)?.conn.send({
      t: "lounge.progress",
      deviceId: device.id,
      step: "failed",
      reason,
    });
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
    this.tellUser(session.userId, device.id, reason);
    await this.announceMember(session.userId);
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
    const entry = (await this.loungeDirectory(session.userId)).get(index);
    if (!entry) return this.refuse(device, "denied");
    const as = { id: session.userId, label: session.name };
    if (entry.kind === "device") return this.appDial(device, entry.id, as);
    return this.userDial(device, entry.id, as);
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
      for (const [index, id] of buttons) {
        const c = byId.get(id);
        if (c?.deviceCanCall && id !== userId && index < 10) {
          out.set(index, { kind: "user", id, label: c.label });
        }
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
    for (const [i, e] of entries.slice(0, 10).entries()) out.set(i, e);
    return out;
  }
}

const idOf = (key: string) => key.slice(4);
