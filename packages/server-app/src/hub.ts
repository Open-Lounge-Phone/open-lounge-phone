import {
  authorizeInbound,
  authorizeOutbound,
  isQuietAt,
  newRoom,
  type RoomEvent,
  type RoomState,
  resolveButton,
  roomStep,
} from "@opentincan/core";
import { type Device, newId, type User } from "@opentincan/db";
import type { AppToServer, DeviceToServer, EndReason, ServerToApp } from "@opentincan/protocol";
import {
  CloseCode,
  CONFIG_TICK_MS,
  CONNECT_TIMEOUT_MS,
  type Conn,
  RING_TIMEOUT_MS,
  type ServerEnv,
} from "./env.ts";

type Status = Extract<DeviceToServer, { t: "status" }>;

/** A live, authenticated connection: a device or one companion-app session of a user. */
export interface Peer {
  kind: "device" | "user";
  id: string;
  /** Party key used in call rooms: `dev:<id>` or `usr:<id>`. */
  key: string;
  label: string;
  conn: Conn;
  guardian: boolean;
}

interface DevicePeer extends Peer {
  kind: "device";
  hook: "up" | "down";
  status?: Status;
  lastQuiet?: boolean;
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
  private cancelTick?: () => void;

  readonly householdId: string;
  private readonly env: ServerEnv;

  constructor(householdId: string, env: ServerEnv) {
    this.householdId = householdId;
    this.env = env;
  }

  /** Serializes all state changes so concurrent messages cannot interleave mid-update. */
  private run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch((e) => this.env.log("error", "hub task failed", { error: String(e) }));
    return next;
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
      this.broadcastStatus(peer, true);
      this.ensureTicker();
      return peer;
    });
  }

  connectApp(user: User, conn: Conn): Promise<Peer> {
    return this.run(async () => {
      const peer: Peer = {
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
      if (this.devices.size === 0) {
        this.cancelTick?.();
        this.cancelTick = undefined;
      }
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
          return;
        case "button":
          return this.deviceDial(device, msg.index);
        case "status":
          device.status = msg;
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

  /** Re-send config to a device after guardians change settings. */
  refreshDevice(deviceId: string): Promise<void> {
    return this.run(async () => {
      const peer = this.devices.get(deviceId);
      if (peer) await this.sendConfig(peer, true);
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
    user.conn.send({ t: "call.state", callId: room.id, state: "ringing" });
    peer.conn.send({ t: "call.ringing", callId: room.id, from: { label: contact.label } });
  }

  private openRoom(caller: Peer, calleeKey: string): Room {
    const room: Room = { id: newId("call"), state: newRoom(caller.key, calleeKey), caller };
    this.rooms.set(room.id, room);
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
    const [buttons, contacts, schedule] = await Promise.all([
      store.listButtons(peer.id),
      store.listContacts(peer.id),
      store.getSchedule(this.householdId),
    ]);
    const quiet = isQuietAt(schedule, new Date(this.env.now()));
    if (!force && quiet === peer.lastQuiet) return;
    peer.lastQuiet = quiet;
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const mapped = [...buttons]
      .map(([index, userId]) => ({ index, contact: byId.get(userId) }))
      .filter((b) => b.contact?.deviceCanCall)
      .map((b) => ({ index: b.index, label: b.contact?.label ?? "" }));
    peer.conn.send({ t: "config", buttons: mapped, quiet });
  }

  /** Quiet hours start and end on their own; re-evaluate every minute while devices are online. */
  private ensureTicker(): void {
    if (this.cancelTick) return;
    const tick = () => {
      this.cancelTick = this.env.setTimer(() => {
        void this.run(async () => {
          for (const d of this.devices.values()) await this.sendConfig(d, false);
        });
        if (this.devices.size > 0) tick();
        else this.cancelTick = undefined;
      }, CONFIG_TICK_MS);
    };
    tick();
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
