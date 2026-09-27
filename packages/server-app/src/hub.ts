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
} from "@opentincan/core";
import { type Device, newId, type User } from "@opentincan/db";
import type { AppToServer, DeviceToServer, EndReason, ServerToApp } from "@opentincan/protocol";
import {
  CloseCode,
  CONNECT_TIMEOUT_MS,
  type Conn,
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
  private cancelQuietTimer?: () => void;
  private roomsDirty = false;

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
    return peers;
  }

  // --- connections ----------------------------------------------------------

  connectDevice(device: Device, conn: Conn): Promise<Peer> {
    return this.run(async () => {
      const old = this.devices.get(device.id);
      if (old) {
        this.dropPeer(old);
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
      };
      this.devices.set(device.id, peer);
      await this.sendConfig(peer, true);
      this.remember(peer);
      this.broadcastStatus(peer, true);
      await this.scheduleQuietCheck();
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
      this.apps.set(user.id, set);
      set.add(peer);
      this.remember(peer);
      conn.send({ t: "app.ready", userId: user.id });
      if (peer.guardian) {
        for (const d of await this.env.store.listDevices(this.householdId)) {
          const live = this.devices.get(d.id);
          conn.send(this.statusMessage(d.id, live, d.lastSeen ?? 0));
        }
      }
      return peer;
    });
  }

  disconnect(peer: Peer): Promise<void> {
    return this.run(() => this.dropPeer(peer));
  }

  private dropPeer(peer: Peer): void {
    if (peer.kind === "device") {
      if (this.devices.get(peer.id) !== peer) return;
      this.devices.delete(peer.id);
      this.broadcastStatus(peer as DevicePeer, false);
      if (this.devices.size === 0) this.cancelQuietCheck();
    } else {
      const set = this.apps.get(peer.id);
      if (!set?.delete(peer)) return;
      if (set.size === 0) this.apps.delete(peer.id);
    }
    for (const room of [...this.rooms.values()]) {
      if (room.caller === peer || room.calleePeer === peer) {
        void this.apply(room, { type: "hangup", by: peer.key });
      } else if (!room.calleePeer && room.state.callee === peer.key && !this.apps.has(peer.id)) {
        // The last ringing session of the callee went away.
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
          return;
        case "button":
          return this.deviceDial(device, msg.index);
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

  /** Re-send config to a device after guardians change settings (incl. quiet hours). */
  refreshDevice(deviceId: string): Promise<void> {
    return this.run(async () => {
      const peer = this.devices.get(deviceId);
      if (!peer) return;
      await this.sendConfig(peer, true);
      await this.scheduleQuietCheck();
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
      if (this.devices.size > 0) await this.scheduleQuietCheck();
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
    const { store } = this.env;
    const [buttons, contacts, schedule] = await Promise.all([
      store.listButtons(device.id),
      store.listContacts(device.id),
      store.getSchedule(this.householdId),
    ]);
    const contact = resolveButton(buttons, new Map(contacts.map((c) => [c.id, c])), index);
    const decision = authorizeOutbound(contact, {
      quietHours: schedule,
      now: new Date(this.env.now()),
    });
    if (decision.decision === "deny" || !contact) return this.refuse(device, "denied");
    const targets = this.apps.get(contact.id);
    if (!targets?.size) return this.refuse(device, "unreachable");
    if (this.busy(userKey(contact.id))) return this.refuse(device, "busy");

    const room = this.openRoom(device, userKey(contact.id));
    device.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    for (const t of targets) {
      t.conn.send({ t: "call.ringing", callId: room.id, from: { label: device.label } });
    }
  }

  private async appDial(user: Peer, deviceId: string): Promise<void> {
    const { store } = this.env;
    const device = await store.getDevice(deviceId);
    if (!device || device.householdId !== this.householdId) {
      user.conn.send({ t: "error", code: "not_found", message: "no such device" });
      return;
    }
    const [contact, schedule] = await Promise.all([
      store.getContact(deviceId, user.id),
      store.getSchedule(this.householdId),
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
    if (!room.calleePeer && room.state.callee === peer.key) return "callee";
    return undefined;
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
      room.calleePeer = peer;
      this.roomsDirty = true;
      // Other sessions of the same user stop ringing.
      for (const other of this.apps.get(peer.id) ?? []) {
        if (other !== peer) {
          other.conn.send({ t: "call.state", callId: room.id, state: "ended", reason: "hangup" });
        }
      }
      await this.apply(room, { type: "answer", by: peer.key });
      return;
    }
    if (msg.t === "call.hangup") {
      await this.apply(room, { type: "hangup", by: peer.key });
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
        const ringing = room.calleePeer ? [] : [...(this.apps.get(idOf(room.state.callee)) ?? [])];
        for (const p of [...both, ...ringing]) {
          p.conn.send({ t: "call.state", callId: room.id, state: "ended", reason });
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
    const [buttons, contacts, schedule, missed] = await Promise.all([
      store.listButtons(peer.id),
      store.listContacts(peer.id),
      store.getSchedule(this.householdId),
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
   * Quiet hours start and end on their own. Sleep until the next change instead of polling, so
   * a Durable Object host can hibernate in between.
   */
  private async scheduleQuietCheck(): Promise<void> {
    const schedule = await this.env.store.getSchedule(this.householdId);
    const next = nextQuietChange(schedule, new Date(this.env.now()));
    this.cancelQuietCheck();
    if (!next) return;
    // A second of slack so the check lands after the boundary.
    const at = next.getTime() + 1000;
    if (this.env.wakeAt) {
      this.env.wakeAt(at);
      return;
    }
    this.cancelQuietTimer = this.env.setTimer(
      () => void this.wake(),
      Math.max(0, at - this.env.now()),
    );
  }

  private cancelQuietCheck(): void {
    this.cancelQuietTimer?.();
    this.cancelQuietTimer = undefined;
    this.env.wakeAt?.(null);
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
    };
  }

  private broadcastStatus(peer: DevicePeer, online: boolean): void {
    const msg = this.statusMessage(peer.id, online ? peer : undefined, this.env.now());
    for (const set of this.apps.values()) {
      for (const app of set) if (app.guardian) app.conn.send(msg);
    }
  }
}

const idOf = (key: string) => key.slice(4);
