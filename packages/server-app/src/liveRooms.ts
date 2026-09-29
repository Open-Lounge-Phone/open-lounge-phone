// Live rooms of one household hub: party lines, phone rooms and 3-way calls. Who's in, host
// controls (mute, remove, lock), the idle rule, fair-use metering, and the audio: a peer-to-peer
// mesh (≤ 4 people, `rtc.*` relayed with `peer`) or a relay — the Cloudflare Realtime SFU driven
// from here (`room.media`), or LiveKit (a join token; clients talk to it directly).
//
// Participants are local peers (an app session or a phone connected to this hub) or remote ones:
// someone in another household here or on another server, whose own hub holds a "room leg" and
// relays for them (`room.signal` over `env.calls`, see `HouseholdHub`).
import {
  forwardFor,
  idleCheck,
  MESH_MAX,
  ROOM_MAX,
  type RoomKind,
  type Speaker,
} from "@openloungephone/core";
import { newId } from "@openloungephone/db";
import type {
  AppToServer,
  RoomEndReason,
  RoomParticipant,
  ServerToApp,
} from "@openloungephone/protocol";
import type { PeerInfo, ServerEnv } from "./env.ts";
import type { Peer } from "./hub.ts";
import { CloudflareSfu, livekitJoinToken, livekitRemove } from "./sfu.ts";

export type RoomMediaKind = "sfu" | "mesh" | "livekit";

/** Messages a participant sends about a room (from their app or phone, or relayed by a leg). */
export type RoomInbound = Extract<
  AppToServer,
  {
    t:
      | "room.leave"
      | "room.mute"
      | "room.remove"
      | "room.lock"
      | "room.talk"
      | "room.here"
      | "room.media"
      | "rtc.sdp"
      | "rtc.ice";
  }
>;

type RoomMediaMsg = Extract<ServerToApp, { t: "room.media" }>;

/** What a room's server knows about someone in it. */
export interface Participant {
  id: string;
  peer: Peer;
  name: string;
  host: boolean;
  muted: boolean;
  speaking: boolean;
  lastSpokeAt: number;
  lastActive: number;
  warnedAt?: number;
  joinedAt: number;
  /** The account whose room minutes this server meters (undefined: metered by their server). */
  payer?: string;
  /** Their server, when it's another one. */
  remoteHost?: string;
  /** Whose audio they get now (relayed rooms). */
  forward: string[];
  /** Cloudflare SFU: their session, microphone and slots (mid → whose audio). */
  sfu?: { sessionId?: string; localMid?: string; pushed: boolean; slots: Record<string, string> };
  /** LiveKit: their join token (minted on join, not kept across restarts). */
  livekitToken?: string;
}

export interface LiveRoom {
  id: string;
  kind: RoomKind;
  name: string;
  address?: string;
  /** Stored rooms: the row (for access). 3-way calls: none. */
  stored?: { ownerAccount: string | null; access: "space" | "connections" };
  locked: boolean;
  media: RoomMediaKind;
  participants: Map<string, Participant>;
}

/** A participant as stored with the hub's rooms (Durable Objects sleep; see `restore`). */
export interface ParticipantSnapshot extends Omit<Participant, "peer" | "livekitToken"> {
  /** A local peer's session, or a remote peer's full info. */
  session?: string;
  remotePeer?: PeerInfo;
}

export interface LiveRoomSnapshot extends Omit<LiveRoom, "participants"> {
  participants: ParticipantSnapshot[];
}

/** What the rooms need from their hub. */
export interface RoomPort {
  env: ServerEnv;
  householdId: string;
  /** Runs `fn` in the hub's queue (for work that comes back from the network). */
  run<T>(fn: () => Promise<T> | T): Promise<T>;
  /** Live state changed: persist it with the hub's rooms. */
  changed(): void;
  /** Re-arm the hub's one alarm (idle deadlines changed). */
  reschedule(): void;
  /** Tells the space's app sessions who's in a stored room now. */
  announce(room: LiveRoom): void;
  /** Rebuilds a remote peer from its info (after a restart). */
  remote(info: PeerInfo): Peer;
}

const CLIENT_WAIT_MS = 15_000;

/** A pending question to a participant's client (the SFU needs its SDP). */
interface Waiting {
  type: "offer" | "answer";
  resolve(sdp: string): void;
  reject(e: Error): void;
  cancel(): void;
}

export class LiveRooms {
  private readonly port: RoomPort;
  private readonly rooms = new Map<string, LiveRoom>();
  /** Per participant: SFU work in order, and a question awaiting the client. */
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, Waiting>();

  constructor(port: RoomPort) {
    this.port = port;
  }

  private get env(): ServerEnv {
    return this.port.env;
  }

  /** How rooms carry audio on this server. */
  mediaKind(): RoomMediaKind {
    const relay = this.env.relay;
    return relay?.kind === "cloudflare" ? "sfu" : relay?.kind === "livekit" ? "livekit" : "mesh";
  }

  maxSize(media: RoomMediaKind): number {
    return media === "mesh" ? MESH_MAX : ROOM_MAX;
  }

  get(roomId: string): LiveRoom | undefined {
    return this.rooms.get(roomId);
  }

  all(): LiveRoom[] {
    return [...this.rooms.values()];
  }

  /** Who's in each room (names), for the space's room list. */
  people(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const r of this.rooms.values())
      out[r.id] = [...r.participants.values()].map((p) => p.name);
    return out;
  }

  /** The room and participant for a peer's message about `roomId`. */
  find(peer: Peer, roomId: string): { room: LiveRoom; p: Participant } | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    for (const p of room.participants.values()) if (p.peer === peer) return { room, p };
    return undefined;
  }

  /** A remote participant, by their server and the leg their server knows the room by. */
  findRemote(host: string, leg: string): { room: LiveRoom; p: Participant } | undefined {
    for (const room of this.rooms.values()) {
      for (const p of room.participants.values()) {
        if (p.peer.kind === "remote" && (p.peer.host ?? "") === host && p.peer.leg === leg) {
          return { room, p };
        }
      }
    }
    return undefined;
  }

  /** Whether this party (`usr:…`, `dev:…`, `fed:…`) is in any room here. */
  inRoom(key: string): boolean {
    for (const room of this.rooms.values()) {
      for (const p of room.participants.values()) if (p.peer.key === key) return true;
    }
    return false;
  }

  /** The live state of a stored room (party line or phone room), created when first joined. */
  open(stored: {
    id: string;
    kind: "party" | "phone";
    name: string;
    address?: string;
    ownerAccount: string | null;
    access: "space" | "connections";
    locked: boolean;
  }): LiveRoom {
    let room = this.rooms.get(stored.id);
    if (!room) {
      room = {
        id: stored.id,
        kind: stored.kind,
        name: stored.name.slice(0, 40),
        ...(stored.address ? { address: stored.address } : {}),
        stored: { ownerAccount: stored.ownerAccount, access: stored.access },
        locked: stored.locked,
        media: this.mediaKind(),
        participants: new Map(),
      };
      this.rooms.set(room.id, room);
    }
    return room;
  }

  /** A new 3-way call room (made by merging two calls). */
  openCall(name: string): LiveRoom {
    const room: LiveRoom = {
      id: newId("rm"),
      kind: "call",
      name: name.slice(0, 40),
      locked: false,
      media: this.mediaKind(),
      participants: new Map(),
    };
    this.rooms.set(room.id, room);
    return room;
  }

  /** Adds someone (access was checked by the caller). Sends them the room; tells the others. */
  async admit(
    room: LiveRoom,
    peer: Peer,
    info: { name: string; host?: boolean; payer?: string; remoteHost?: string },
  ): Promise<Participant> {
    const now = this.env.now();
    const p: Participant = {
      id: newId("p"),
      peer,
      name: info.name.slice(0, 24) || "Someone",
      host: info.host === true,
      muted: false,
      speaking: false,
      lastSpokeAt: 0,
      lastActive: now,
      joinedAt: now,
      forward: [],
      ...(info.payer ? { payer: info.payer } : {}),
      ...(info.remoteHost ? { remoteHost: info.remoteHost } : {}),
      ...(room.media === "sfu" ? { sfu: { pushed: false, slots: {} } } : {}),
    };
    room.participants.set(p.id, p);
    const relay = this.env.relay;
    if (room.media === "livekit" && relay?.kind === "livekit") {
      p.livekitToken = await livekitJoinToken(
        relay,
        { room: room.id, identity: p.id, name: p.name },
        now,
      );
    }
    // A local peer gets this server's ICE servers; a remote one gets its own server's.
    if (peer.kind !== "remote") {
      peer.conn.send({ t: "rtc.config", callId: room.id, iceServers: await this.iceFor(room) });
    }
    this.recompute(room);
    this.broadcast(room);
    this.port.changed();
    this.port.reschedule();
    if (room.stored) this.port.announce(room);
    return p;
  }

  private async iceFor(room: LiveRoom) {
    const ice = await this.env.iceServers();
    // The SFU is on the public internet; STUN finds the way (TURN from the list still helps).
    return room.media === "sfu" && ice.length === 0
      ? [{ urls: "stun:stun.cloudflare.com:3478" }]
      : ice;
  }

  /** Takes someone out (left, removed, idle, …). Closes a 3-way call once one person is left. */
  async leave(room: LiveRoom, p: Participant, reason: RoomEndReason, notify = true): Promise<void> {
    if (room.participants.get(p.id) !== p) return;
    room.participants.delete(p.id);
    this.waiting.get(p.id)?.reject(new Error("left"));
    const now = this.env.now();
    if (notify) p.peer.conn.send({ t: "room.ended", roomId: room.id, reason });
    if (p.payer) {
      const minutes = Math.max(1, Math.ceil((now - p.joinedAt) / 60_000));
      await this.env.store
        .addUsage(p.payer, now, { roomMinutes: minutes })
        .catch((e) => this.env.log("warn", "room metering failed", { error: String(e) }));
    }
    this.releaseMedia(room, p);
    if (room.kind === "call" && room.participants.size <= 1) {
      for (const last of [...room.participants.values()]) await this.leave(room, last, "closed");
    }
    if (room.participants.size === 0) this.rooms.delete(room.id);
    else {
      this.recompute(room);
      this.broadcast(room);
    }
    this.port.changed();
    this.port.reschedule();
    if (room.stored) this.port.announce(room);
  }

  /** Ends a room for everyone (the room was deleted). */
  async close(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const p of [...room.participants.values()]) await this.leave(room, p, "closed");
    this.rooms.delete(roomId);
  }

  /** A peer went away (socket closed, phone removed): out of every room, quietly. */
  async dropPeer(peer: Peer): Promise<void> {
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.participants.values()]) {
        if (p.peer === peer) await this.leave(room, p, "left", false);
      }
    }
  }

  /** A message from a participant about their room. */
  async message(room: LiveRoom, p: Participant, msg: RoomInbound): Promise<void> {
    const now = this.env.now();
    switch (msg.t) {
      case "room.leave":
        return this.leave(room, p, "left");
      case "room.here":
        this.touch(p, now);
        return;
      case "room.talk": {
        if (msg.speaking) this.touch(p, now);
        if (p.speaking === msg.speaking) return;
        p.speaking = msg.speaking;
        p.lastSpokeAt = now;
        if (this.recompute(room)) this.broadcast(room);
        return;
      }
      case "room.mute": {
        const target = msg.participant ? room.participants.get(msg.participant) : p;
        if (!target) return;
        // Anyone mutes or unmutes themselves; the host may also mute (not unmute) others.
        if (target !== p && (!p.host || !msg.muted)) {
          p.peer.conn.send({
            t: "error",
            code: "unauthorized",
            message: "only the host can mute others",
          });
          return;
        }
        this.touch(p, now);
        if (target.muted === msg.muted) return;
        target.muted = msg.muted;
        if (msg.muted) target.speaking = false;
        this.recompute(room);
        this.broadcast(room);
        this.port.changed();
        return;
      }
      case "room.remove": {
        const target = room.participants.get(msg.participant);
        if (!p.host || !target || target === p) {
          p.peer.conn.send({
            t: "error",
            code: "unauthorized",
            message: "only the host can remove people",
          });
          return;
        }
        this.touch(p, now);
        return this.leave(room, target, "removed");
      }
      case "room.lock": {
        if (!p.host) {
          p.peer.conn.send({
            t: "error",
            code: "unauthorized",
            message: "only the host can lock the room",
          });
          return;
        }
        this.touch(p, now);
        if (room.locked === msg.locked) return;
        room.locked = msg.locked;
        this.broadcast(room);
        this.port.changed();
        if (room.stored) {
          await this.env.store.rooms
            .update(room.id, { locked: msg.locked })
            .catch((e) => this.env.log("warn", "room lock not saved", { error: String(e) }));
        }
        return;
      }
      case "room.media":
        return this.media(room, p, msg);
      case "rtc.sdp":
      case "rtc.ice": {
        // Mesh: relay to the other participant, saying who it's from.
        if (room.media !== "mesh" || !msg.peer) return;
        const to = room.participants.get(msg.peer);
        if (!to || to === p) return;
        to.peer.conn.send({ ...msg, callId: room.id, peer: p.id });
        return;
      }
    }
  }

  private touch(p: Participant, now: number): void {
    const wasWarned = p.warnedAt !== undefined;
    p.lastActive = now;
    delete p.warnedAt;
    if (wasWarned) this.port.reschedule();
  }

  // --- idle rule -------------------------------------------------------------------

  /** The next time someone must be warned or dropped. */
  nextDeadline(now: number): number | undefined {
    let at: number | undefined;
    for (const room of this.rooms.values()) {
      for (const p of room.participants.values()) {
        const v = idleCheck(p, now);
        const due = v.action === "none" ? v.next : now;
        at = at === undefined ? due : Math.min(at, due);
      }
    }
    return at;
  }

  /** Warns and drops people who've been silent and idle (called when the hub wakes). */
  async sweepIdle(now: number): Promise<void> {
    for (const room of [...this.rooms.values()]) {
      for (const p of [...room.participants.values()]) {
        const v = idleCheck(p, now);
        if (v.action === "warn") {
          p.warnedAt = now;
          p.peer.conn.send({ t: "room.idle", roomId: room.id, dropAt: v.dropAt });
          this.port.changed();
        } else if (v.action === "drop") {
          await this.leave(room, p, "idle");
        }
      }
    }
  }

  // --- state and forwarding ----------------------------------------------------------

  private view(room: LiveRoom): RoomParticipant[] {
    return [...room.participants.values()].map((x) => ({
      id: x.id,
      name: x.name,
      muted: x.muted,
      ...(x.speaking ? { speaking: true } : {}),
      ...(x.host ? { host: true } : {}),
      ...(x.remoteHost ? { remote: x.remoteHost } : {}),
    }));
  }

  /** `room.state` for one participant. */
  stateFor(room: LiveRoom, p: Participant): Extract<ServerToApp, { t: "room.state" }> {
    const relay = this.env.relay;
    return {
      t: "room.state",
      roomId: room.id,
      name: room.name,
      kind: room.kind,
      ...(room.address ? { address: room.address } : {}),
      you: p.id,
      locked: room.locked,
      media: room.media,
      e2ee: room.media === "mesh",
      participants: this.view(room).slice(0, 32),
      ...(room.media !== "mesh" ? { forward: p.forward.slice(0, 32) } : {}),
      ...(room.media === "livekit" && relay?.kind === "livekit" && p.livekitToken
        ? { livekit: { url: relay.url, token: p.livekitToken } }
        : {}),
    };
  }

  broadcast(room: LiveRoom): void {
    for (const p of room.participants.values()) p.peer.conn.send(this.stateFor(room, p));
  }

  /**
   * Whose audio each participant gets (everyone in small rooms, the top 3 speakers in rooms of
   * more than 4; never the muted). Returns whether anyone's set changed. On the SFU, it then
   * moves the slots to match.
   */
  recompute(room: LiveRoom): boolean {
    const sources: Speaker[] = [...room.participants.values()]
      .filter((x) => room.media !== "sfu" || x.sfu?.pushed)
      .map((x) => ({ id: x.id, speaking: x.speaking, lastSpokeAt: x.lastSpokeAt, muted: x.muted }));
    let changed = false;
    for (const p of room.participants.values()) {
      const next = forwardFor(p.id, sources, p.forward);
      const same = next.length === p.forward.length && next.every((id) => p.forward.includes(id));
      if (!same) changed = true;
      p.forward = next;
      if (room.media === "sfu" && !same) this.sync(room, p);
    }
    return changed;
  }

  // --- the Cloudflare SFU ---------------------------------------------------------------

  private sfu(): CloudflareSfu | undefined {
    const relay = this.env.relay;
    return relay?.kind === "cloudflare"
      ? new CloudflareSfu(relay, this.env.fetch ?? ((r) => fetch(r)))
      : undefined;
  }

  /** Runs SFU work for one participant in order, outside the hub's queue (it's network I/O). */
  private chain(p: Participant, work: () => Promise<void>): void {
    const prev = this.chains.get(p.id) ?? Promise.resolve();
    const next = prev.then(work).catch((e) => {
      this.env.log("warn", "room media failed", { participant: p.id, error: String(e) });
    });
    this.chains.set(p.id, next);
  }

  /** Asks the client for SDP (an answer to our offer, or a new offer after a close). */
  private ask(p: Participant, msg: RoomMediaMsg, expect: "offer" | "answer"): Promise<string> {
    this.waiting.get(p.id)?.reject(new Error("superseded"));
    return new Promise<string>((resolve, reject) => {
      const cancelTimer = this.env.setTimer(() => {
        if (this.waiting.get(p.id) === w) this.waiting.delete(p.id);
        reject(new Error(`no ${expect} from the client`));
      }, CLIENT_WAIT_MS);
      const w: Waiting = {
        type: expect,
        resolve: (sdp) => {
          cancelTimer();
          this.waiting.delete(p.id);
          resolve(sdp);
        },
        reject: (e) => {
          cancelTimer();
          if (this.waiting.get(p.id) === w) this.waiting.delete(p.id);
          reject(e);
        },
        cancel: cancelTimer,
      };
      this.waiting.set(p.id, w);
      p.peer.conn.send(msg);
    });
  }

  private async media(
    room: LiveRoom,
    p: Participant,
    msg: Extract<RoomInbound, { t: "room.media" }>,
  ) {
    if (room.media !== "sfu" || !p.sfu || msg.type === "close" || !msg.sdp) return;
    const waiting = this.waiting.get(p.id);
    if (waiting && waiting.type === msg.type) {
      waiting.resolve(msg.sdp);
      return;
    }
    if (msg.type !== "offer" || p.sfu.pushed) return;
    // The client's first offer: its microphone.
    const offer = msg.sdp;
    const sfu = this.sfu();
    if (!sfu) return;
    this.chain(p, async () => {
      const state = p.sfu;
      if (!state || !room.participants.has(p.id)) return;
      try {
        state.sessionId ??= await sfu.newSession();
        const answer = await sfu.push(state.sessionId, offer, p.id);
        state.localMid = /\r?\na=mid:(\S+)/.exec(offer.split(/\r?\nm=audio/)[1] ?? "")?.[1] ?? "0";
        state.pushed = true;
        p.peer.conn.send({ t: "room.media", roomId: room.id, type: "answer", sdp: answer });
      } catch (e) {
        this.env.log("warn", "room: the relay refused the microphone", { error: String(e) });
        await this.port.run(() => this.leave(room, p, "error"));
        return;
      }
      await this.port.run(() => {
        if (!room.participants.has(p.id)) return;
        this.recompute(room);
        this.broadcast(room);
        this.port.changed();
      });
    });
  }

  /** Makes a participant's SFU slots match `forward`: close what's gone, pull what's new. */
  private sync(room: LiveRoom, p: Participant): void {
    const sfu = this.sfu();
    if (!sfu || !p.sfu?.pushed) return;
    this.chain(p, async () => {
      const state = p.sfu;
      if (!state?.sessionId || !room.participants.has(p.id)) return;
      const session = state.sessionId;
      const want = p.forward.filter((id) => room.participants.get(id)?.sfu?.pushed);
      const stale = Object.entries(state.slots)
        .filter(([, src]) => !want.includes(src))
        .map(([mid]) => mid);
      if (stale.length) {
        const offer = await this.ask(
          p,
          { t: "room.media", roomId: room.id, type: "close", mids: stale },
          "offer",
        );
        const answer = await sfu.close(session, stale, offer);
        for (const mid of stale) delete state.slots[mid];
        if (answer)
          p.peer.conn.send({ t: "room.media", roomId: room.id, type: "answer", sdp: answer });
      }
      const have = new Set(Object.values(state.slots));
      const add = want.filter((id) => !have.has(id));
      const sources = add
        .map((id) => ({ id, s: room.participants.get(id)?.sfu?.sessionId }))
        .filter((x): x is { id: string; s: string } => !!x.s);
      if (sources.length) {
        const r = await sfu.pull(
          session,
          sources.map((x) => ({ sessionId: x.s, trackName: x.id })),
        );
        r.mids.forEach((mid, i) => {
          const src = sources[i];
          if (mid && src) state.slots[mid] = src.id;
        });
        if (r.offer) {
          const answer = await this.ask(
            p,
            { t: "room.media", roomId: room.id, type: "offer", sdp: r.offer },
            "answer",
          );
          await sfu.renegotiate(session, answer);
        }
      }
      this.port.changed();
    });
  }

  /** Someone left: stop their relay session (so a removed person hears nothing more). */
  private releaseMedia(room: LiveRoom, p: Participant): void {
    const relay = this.env.relay;
    const sfu = this.sfu();
    const state = p.sfu;
    if (sfu && state?.sessionId) {
      const mids = [...(state.localMid ? [state.localMid] : []), ...Object.keys(state.slots)];
      const session = state.sessionId;
      this.chain(p, () => sfu.close(session, mids).then(() => undefined));
    }
    if (relay?.kind === "livekit") {
      this.env.defer(
        livekitRemove(relay, room.id, p.id, this.env.now(), this.env.fetch).catch((e) =>
          this.env.log("warn", "livekit remove failed", { error: String(e) }),
        ),
      );
    }
    this.chains.delete(p.id);
  }

  // --- sleeping hosts ------------------------------------------------------------------

  snapshot(): LiveRoomSnapshot[] {
    return [...this.rooms.values()].map((room) => ({
      ...room,
      participants: [...room.participants.values()].map(({ peer, livekitToken: _t, ...rest }) => ({
        ...rest,
        ...(peer.kind === "remote"
          ? { remotePeer: { ...peerInfo(peer), key: peer.key } as PeerInfo }
          : { session: peer.session }),
      })),
    }));
  }

  /** Rebuilds rooms after the host slept; participants whose peer is gone are dropped. */
  restore(snaps: LiveRoomSnapshot[], bySession: Map<string, Peer>): void {
    for (const snap of snaps) {
      const participants = new Map<string, Participant>();
      for (const s of snap.participants) {
        const { session, remotePeer, ...rest } = s;
        const peer = remotePeer
          ? this.port.remote(remotePeer)
          : session
            ? bySession.get(session)
            : undefined;
        if (peer) participants.set(rest.id, { ...rest, peer });
      }
      if (participants.size === 0) continue;
      this.rooms.set(snap.id, { ...snap, participants });
    }
  }
}

const peerInfo = ({ key: _key, conn: _conn, ...info }: Peer): PeerInfo => info;
