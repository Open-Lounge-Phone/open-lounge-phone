import {
  CallMedia,
  getMicrophone,
  ProtocolSocket,
  RoomAudio,
  type SocketStatus,
  socketUrl,
  TonePlayer,
} from "@openloungephone/client";
import {
  type AppToServer,
  decodeServerToApp,
  type IceServer,
  PROTOCOL_VERSION,
  type RoomEndReason,
  type RoomParticipant,
  type ServerToApp,
  type TransferTarget,
} from "@openloungephone/protocol";
import { type CallEvent, type CallView, callStep, canLeaveVoicemail, toneFor } from "./calls.ts";

export interface DeviceLive {
  online: boolean;
  battery?: { pct: number; charging: boolean };
  rssi?: number;
  power?: { source: "default" | "1.5A" | "3A"; reduced: boolean };
  lastSeen: number;
  /** Lounge phone: who is using it. */
  lounge?: { userId: string; name: string; since: number };
}

/** Another member of the server, as their app sessions report it. */
export interface MemberLive {
  online: boolean;
  available: boolean;
  /** At a Lounge phone right now (calls to them ring there). */
  lounge?: { deviceId: string; label: string; openToChat: boolean };
}

/** Your own takeover of a Lounge phone, as the server reports it. */
export interface LoungeClaim {
  deviceId: string;
  step: "sending" | "press_key" | "started" | "failed" | "ended";
  reason?: string;
  expiresAt?: number;
}

/** A call you put on hold (while you consult someone else, or just for a moment). */
export interface HeldCall {
  callId: string;
  label: string;
  /** How it looked before it was held, to put it back. */
  view: Extract<CallView, { offerer: boolean }>;
}

/** The room you're in, as its server reports it. */
export interface RoomView {
  roomId: string;
  name: string;
  kind: "party" | "phone" | "call";
  address?: string;
  you: string;
  locked: boolean;
  media: "sfu" | "mesh" | "livekit";
  e2ee: boolean;
  participants: RoomParticipant[];
  forward?: string[];
  host: boolean;
  muted: boolean;
  /** You'll be dropped then unless you speak or tap "I'm here". */
  idleDropAt?: number;
  /** Its audio is up. */
  connected: boolean;
}

export interface Snapshot {
  status: SocketStatus;
  call: CallView;
  /** A call on hold (MENU → Add caller / Hold). */
  held?: HeldCall;
  /** The room you're in (a party line, a phone room, or a 3-way call). */
  room?: RoomView;
  /** Joining a room: waiting for the server. */
  joining?: boolean;
  /** Who's in each of the space's rooms, from `rooms.changed` (by room id). */
  roomPeople?: Record<string, string[]>;
  /** Bumped on every `rooms.changed`. */
  roomsSeq?: number;
  live: Record<string, DeviceLive>;
  /** Presence of the other members, by user id. */
  members: Record<string, MemberLive>;
  remote?: MediaStream;
  muted: boolean;
  error?: string;
  /** Your latest Lounge takeover / session event. */
  lounge?: LoungeClaim;
  /** Bumped on every `connections.changed` (a knock arrived, someone accepted…). */
  connectionsSeq?: number;
  /** Latest `voicemail.new` (a phone's) or `voicemail.inbox` (yours); `seq` changes each time. */
  voicemail?: { seq: number; id: string; deviceId?: string; from: string };
}

type Rtc = Extract<ServerToApp, { t: "rtc.sdp" | "rtc.ice" }>;

const ENDED_DISPLAY_MS = 3000;
/** How long an action waits for the connection when the app has only just opened. */
const CONNECT_WAIT_MS = 8000;
const UNAUTHORIZED = 4401;
const BAD_HANDSHAKE = 4400;

/** One call's audio (the current one, or one on hold). */
interface CallAudio {
  media?: CallMedia;
  /** Its own copy of the microphone, so holding one call doesn't silence the other. */
  mic: MediaStream;
  pending: Rtc[];
  remote?: MediaStream;
}

type RoomMsg = Extract<ServerToApp, { t: "room.media" | "rtc.sdp" | "rtc.ice" }>;

/** How long a merged call's audio may linger while the room's audio comes up. */
const LINGER_MS = 15_000;

/**
 * The app's live link to the server: socket, device presence, the current call (and one on
 * hold), and the room you're in, with their microphone and WebRTC media. React subscribes via
 * `subscribe` / `getSnapshot`.
 */
export class Connection {
  private snap: Snapshot = {
    status: "connecting",
    call: { phase: "idle" },
    live: {},
    members: {},
    muted: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly socket: ProtocolSocket<ServerToApp, AppToServer>;
  private readonly tones = new TonePlayer();
  private readonly ice = new Map<string, IceServer[]>();
  /** Audio per call id (the current call and the one on hold). */
  private readonly calls = new Map<string, CallAudio>();
  private mic?: MediaStream;
  private dismissTimer?: ReturnType<typeof setTimeout>;
  /** Merged calls whose audio plays until the room's is connected. */
  private lingering: { audio: CallAudio; el?: HTMLAudioElement }[] = [];
  private lingerTimer?: ReturnType<typeof setTimeout>;
  private roomAudio?: RoomAudio;
  private roomPending: RoomMsg[] = [];
  private idleTimer?: ReturnType<typeof setTimeout>;
  /** Signed in on the current socket (`app.ready` seen since it opened). */
  private ready = false;
  private readonly readyWaiters = new Set<(ok: boolean) => void>();

  constructor(token: string, householdId: string, onUnauthorized: () => void) {
    this.socket = new ProtocolSocket<ServerToApp, AppToServer>({
      url: socketUrl(`/ws/app?household=${encodeURIComponent(householdId)}`),
      decode: decodeServerToApp,
      onOpen: (send) =>
        send({ t: "app.hello", proto: PROTOCOL_VERSION, token, household: householdId }),
      onMessage: (msg) => this.onMessage(msg),
      onStatus: (status, detail) => {
        if (status !== "open") this.ready = false;
        this.set({ status });
        if (detail?.code === UNAUTHORIZED) onUnauthorized();
      },
      shouldReconnect: (code) => code !== UNAUTHORIZED && code !== BAD_HANDSHAKE,
    });
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  close(): void {
    for (const id of [...this.calls.keys()]) this.closeCall(id);
    this.endLinger();
    this.closeRoomAudio();
    this.releaseMic();
    this.tones.play("none");
    this.socket.close();
  }

  // --- user actions (call from click handlers so audio/mic permissions apply) ---

  /** Whether a new call may start now: nothing going on, or consulting while one is held. */
  private canDial(): boolean {
    const phase = this.snap.call.phase;
    return (phase === "idle" || phase === "ended") && !this.snap.room && !this.snap.joining;
  }

  async dial(deviceId: string, label: string): Promise<void> {
    await this.dialWith({ type: "dial", label, deviceId }, { t: "call.dial", deviceId });
  }

  /** Grown-up, app-to-app call. The server refuses it unless they're online and available. */
  async callUser(userId: string, label: string): Promise<void> {
    await this.dialWith({ type: "dial", label, person: true }, { t: "call.user", userId });
  }

  /** Calls someone you're connected with (another household or another server). */
  async callConnection(connectionId: string, label: string): Promise<void> {
    await this.dialWith(
      { type: "dial", label, person: true, via: connectionId },
      { t: "call.connection", connectionId },
    );
  }

  /** Calls a phone a connection shared (you're on its allow-list). */
  async callSharedPhone(connectionId: string, deviceId: string, label: string): Promise<void> {
    await this.dialWith(
      { type: "dial", label, deviceId, via: connectionId },
      { t: "call.phone", connectionId, deviceId },
    );
  }

  private async dialWith(
    event: Extract<CallEvent, { type: "dial" }>,
    msg: Extract<AppToServer, { t: "call.dial" | "call.user" | "call.connection" | "call.phone" }>,
  ): Promise<void> {
    if (!this.canDial()) return;
    this.tones.unlock();
    if (!(await this.acquireMic())) return;
    this.apply(event);
    if (!this.socket.send(msg)) {
      this.apply({ type: "hangup" });
      this.set({ error: "Not connected to the server" });
    }
  }

  /** Whether you're taking app-to-app calls; the server remembers it. */
  setAvailable(available: boolean): boolean {
    return this.socket.send({ t: "presence.set", available });
  }

  /**
   * Resolves true once the socket is open and signed in (`app.ready`), or false after
   * `timeoutMs`. For actions taken right after the app opens, e.g. from a scanned QR code.
   */
  whenReady(timeoutMs = CONNECT_WAIT_MS): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      this.readyWaiters.add(done);
    });
  }

  /**
   * Take over a Lounge phone (from its QR code); the phone then asks for the key proof. Waits
   * briefly for the connection when the app has only just opened.
   */
  async claimLounge(deviceId: string, nonce: string): Promise<boolean> {
    if (!(await this.whenReady())) return false;
    const ok = this.socket.send({ t: "lounge.claim", deviceId, nonce });
    if (ok) this.set({ lounge: { deviceId, step: "sending" } });
    return ok;
  }

  leaveLounge(deviceId: string): boolean {
    return this.socket.send({ t: "lounge.leave", deviceId });
  }

  async answer(): Promise<void> {
    const call = this.snap.call;
    if (call.phase !== "incoming") return;
    this.tones.unlock();
    if (!(await this.acquireMic())) {
      this.decline();
      return;
    }
    this.socket.send({ t: "call.answer", callId: call.callId });
    this.apply({ type: "answer" });
  }

  decline(): void {
    this.hangup();
  }

  hangup(): void {
    const call = this.snap.call;
    if ("callId" in call && call.callId)
      this.socket.send({ t: "call.hangup", callId: call.callId });
    this.apply({ type: "hangup" });
  }

  /** Hangs up the call on hold. */
  hangupHeld(): void {
    const held = this.snap.held;
    if (!held) return;
    this.socket.send({ t: "call.hangup", callId: held.callId });
    this.closeCall(held.callId);
    this.set({ held: undefined });
    this.maybeReleaseMic();
  }

  /** Puts the current call on hold (then you may call someone else: Add caller). */
  hold(): void {
    const call = this.snap.call;
    if (call.phase !== "active" || call.hold || this.snap.held) return;
    this.socket.send({ t: "call.hold", callId: call.callId, hold: true });
  }

  /** Takes the held call back (once the other call is over). */
  resume(): void {
    const held = this.snap.held;
    if (!held || !this.canDial()) return;
    this.socket.send({ t: "call.hold", callId: held.callId, hold: false });
  }

  /** 3-way: the held call and the current one become one room. */
  merge(): void {
    const held = this.snap.held;
    const call = this.snap.call;
    if (!held || call.phase !== "active") return;
    this.set({ joining: true });
    this.socket.send({ t: "call.merge", callId: held.callId, with: call.callId });
  }

  /** Blind transfer of the current call: they ring the target themselves; you leave. */
  transfer(to: TransferTarget): void {
    const call = this.snap.call;
    if (call.phase !== "active") return;
    this.socket.send({ t: "call.transfer", callId: call.callId, to });
  }

  /** Attended transfer: connect the held person and the current one; you leave both. */
  transferHeld(): void {
    const held = this.snap.held;
    const call = this.snap.call;
    if (!held || call.phase !== "active") return;
    this.socket.send({ t: "call.transfer", callId: held.callId, toCall: call.callId });
  }

  toggleMute(): void {
    const muted = !this.snap.muted;
    const call = this.snap.call;
    const current = "callId" in call && call.callId ? this.calls.get(call.callId) : undefined;
    for (const t of current?.mic.getAudioTracks() ?? []) t.enabled = !muted;
    const room = this.snap.room;
    if (room) {
      this.roomAudio?.setMuted(muted);
      this.socket.send({ t: "room.mute", roomId: room.roomId, muted });
    }
    this.set({ muted });
  }

  dismiss(): void {
    this.apply({ type: "dismiss" });
  }

  clearError(): void {
    this.set({ error: undefined });
  }

  // --- rooms ---

  /** Joins a room of this space, or a phone room anywhere by its address. */
  async joinRoom(target: { roomId: string } | { address: string }): Promise<void> {
    if (!this.canDial() || this.snap.held) return;
    this.tones.unlock();
    if (!(await this.acquireMic())) return;
    this.set({ joining: true });
    if (!this.socket.send({ t: "room.join", ...target })) {
      this.set({ joining: false, error: "Not connected to the server" });
      this.maybeReleaseMic();
    }
  }

  leaveRoom(): void {
    const room = this.snap.room;
    if (room) this.socket.send({ t: "room.leave", roomId: room.roomId });
    this.endRoom();
  }

  /** "I'm still here" (after an idle warning). */
  stillHere(): void {
    const room = this.snap.room;
    if (!room) return;
    this.socket.send({ t: "room.here", roomId: room.roomId });
    this.set({ room: { ...room, idleDropAt: undefined } });
  }

  /** Host: mute someone (they may unmute themselves). */
  muteParticipant(participant: string): void {
    const room = this.snap.room;
    if (room) this.socket.send({ t: "room.mute", roomId: room.roomId, muted: true, participant });
  }

  /** Host: take someone out of the room. */
  removeParticipant(participant: string): void {
    const room = this.snap.room;
    if (room) this.socket.send({ t: "room.remove", roomId: room.roomId, participant });
  }

  /** Host: nobody new gets in while locked. */
  lockRoom(locked: boolean): void {
    const room = this.snap.room;
    if (room) this.socket.send({ t: "room.lock", roomId: room.roomId, locked });
  }

  // --- internals ---

  private set(patch: Partial<Snapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  private async acquireMic(): Promise<boolean> {
    if (this.mic) return true;
    try {
      this.mic = await getMicrophone();
      return true;
    } catch (e) {
      this.set({ error: `Microphone unavailable: ${(e as Error).message}` });
      return false;
    }
  }

  /** A copy of the microphone for one call or room. */
  private micCopy(): MediaStream {
    const tracks = (this.mic?.getAudioTracks() ?? []).map((t) => {
      const c = t.clone();
      c.enabled = !this.snap.muted;
      return c;
    });
    return new MediaStream(tracks);
  }

  private releaseMic(): void {
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = undefined;
  }

  /** Lets the microphone go once nothing uses it. */
  private maybeReleaseMic(): void {
    const call = this.snap.call;
    const busy =
      this.calls.size > 0 ||
      this.lingering.length > 0 ||
      !!this.snap.room ||
      !!this.snap.joining ||
      call.phase === "outgoing" ||
      call.phase === "incoming" ||
      call.phase === "connecting" ||
      call.phase === "active";
    if (busy) return;
    this.releaseMic();
    if (this.snap.muted) this.set({ muted: false });
  }

  private closeCall(callId: string): void {
    const audio = this.calls.get(callId);
    if (!audio) return;
    this.calls.delete(callId);
    audio.media?.close();
    for (const t of audio.mic.getTracks()) t.stop();
    this.ice.delete(callId);
  }

  private apply(event: CallEvent): void {
    const before = this.snap.call;
    const beforeId = "callId" in before ? before.callId : undefined;
    const { view, decline, merged, transferred } = callStep(before, event);
    if (decline) this.socket.send({ t: "call.hangup", callId: decline });
    if (view === before) return;
    // You held this call: it moves aside, and you may call someone else.
    if (view.phase === "active" && view.hold === "you") {
      const audio = this.calls.get(view.callId);
      for (const t of audio?.mic.getAudioTracks() ?? []) t.enabled = false;
      const { hold: _h, ...rest } = view;
      this.tones.play("none");
      this.set({
        held: { callId: view.callId, label: view.label, view: rest },
        call: { phase: "idle" },
        remote: undefined,
      });
      return;
    }
    this.tones.play(toneFor(view));
    if (merged && beforeId) this.linger(beforeId, merged);
    else if (transferred) this.closeCall(transferred);
    else if ((view.phase === "ended" || view.phase === "idle") && beforeId)
      this.closeCall(beforeId);
    if (view.phase === "active") {
      // While they hold you, you're not heard either.
      const audio = this.calls.get(view.callId);
      for (const t of audio?.mic.getAudioTracks() ?? []) {
        t.enabled = view.hold !== "them" && !this.snap.muted;
      }
    }
    clearTimeout(this.dismissTimer);
    // An unanswered call with a voicemail offer stays up while the caller leaves a message.
    if (view.phase === "ended" && !canLeaveVoicemail(view)) {
      this.dismissTimer = setTimeout(() => this.dismiss(), ENDED_DISPLAY_MS);
    }
    const current = "callId" in view && view.callId ? this.calls.get(view.callId) : undefined;
    this.set({ call: view, remote: current?.remote });
    if (view.phase === "ended" || view.phase === "idle") this.maybeReleaseMic();
  }

  /** The held call's own news: it ended, or it's back (resumed). */
  private heldState(msg: Extract<ServerToApp, { t: "call.state" }>): void {
    const held = this.snap.held;
    if (!held) return;
    if (msg.state === "ended") {
      if (msg.merged) this.linger(held.callId, msg.merged.roomId);
      else this.closeCall(held.callId);
      this.set({ held: undefined });
      this.maybeReleaseMic();
      return;
    }
    if (msg.state === "active" && !msg.hold) {
      // Resumed: back as the current call.
      const audio = this.calls.get(held.callId);
      for (const t of audio?.mic.getAudioTracks() ?? []) t.enabled = !this.snap.muted;
      this.set({ held: undefined, call: held.view, remote: audio?.remote });
    }
  }

  /** A call merged into a room: its audio keeps playing until the room's is connected. */
  private linger(callId: string, roomId: string): void {
    const audio = this.calls.get(callId);
    if (!audio) return;
    this.calls.delete(callId);
    for (const t of audio.mic.getAudioTracks()) t.enabled = !this.snap.muted;
    let el: HTMLAudioElement | undefined;
    if (audio.remote && typeof Audio !== "undefined") {
      el = new Audio();
      el.autoplay = true;
      el.srcObject = audio.remote;
      void el.play().catch(() => {});
    }
    this.lingering.push({ audio, ...(el ? { el } : {}) });
    this.set({ joining: !this.snap.room || this.snap.room.roomId !== roomId });
    clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => this.endLinger(), LINGER_MS);
  }

  private endLinger(): void {
    clearTimeout(this.lingerTimer);
    for (const { audio, el } of this.lingering.splice(0)) {
      audio.media?.close();
      for (const t of audio.mic.getTracks()) t.stop();
      if (el) el.srcObject = null;
    }
  }

  private closeRoomAudio(): void {
    this.roomAudio?.close();
    this.roomAudio = undefined;
    this.roomPending = [];
    clearTimeout(this.idleTimer);
  }

  private endRoom(): void {
    const room = this.snap.room;
    this.closeRoomAudio();
    this.endLinger();
    if (room) this.ice.delete(room.roomId);
    this.set({ room: undefined, joining: false });
    this.maybeReleaseMic();
  }

  private roomState(msg: Extract<ServerToApp, { t: "room.state" }>): void {
    const me = msg.participants.find((p) => p.id === msg.you);
    const prev = this.snap.room?.roomId === msg.roomId ? this.snap.room : undefined;
    const room: RoomView = {
      roomId: msg.roomId,
      name: msg.name,
      kind: msg.kind,
      ...(msg.address ? { address: msg.address } : {}),
      you: msg.you,
      locked: msg.locked,
      media: msg.media,
      e2ee: msg.e2ee,
      participants: msg.participants,
      ...(msg.forward ? { forward: msg.forward } : {}),
      host: me?.host === true,
      muted: me?.muted ?? false,
      ...(prev?.idleDropAt ? { idleDropAt: prev.idleDropAt } : {}),
      connected: prev?.connected ?? false,
    };
    if (!this.roomAudio || this.roomAudio.roomId !== msg.roomId) {
      this.closeRoomAudio();
      if (!this.mic) {
        // Merged by someone else while we had no microphone copy left: get one.
        void this.acquireMic().then((ok) => (ok ? this.roomState(msg) : this.leaveRoom()));
        return;
      }
      this.roomAudio = new RoomAudio({
        roomId: msg.roomId,
        iceServers: this.ice.get(msg.roomId) ?? [],
        microphone: this.micCopy(),
        send: (m) => this.socket.send(m),
        onConnected: () => {
          this.endLinger();
          const r = this.snap.room;
          if (r?.roomId === msg.roomId) this.set({ room: { ...r, connected: true } });
        },
      });
      for (const m of this.roomPending.splice(0)) this.roomAudio.handle(m);
    }
    this.roomAudio.update(msg);
    this.tones.play("none");
    this.set({
      room,
      joining: false,
      muted: room.muted,
      call: this.snap.call.phase === "ended" ? { phase: "idle" } : this.snap.call,
    });
  }

  private onMessage(msg: ServerToApp): void {
    switch (msg.t) {
      case "app.ready":
        this.ready = true;
        for (const w of [...this.readyWaiters]) w(true);
        return;
      case "pong":
        return;
      case "connections.changed":
        this.set({ connectionsSeq: (this.snap.connectionsSeq ?? 0) + 1 });
        return;
      case "error":
        // A refused hold, merge or transfer: the calls stay as they were.
        this.set({ error: msg.message, joining: false });
        return;
      case "device.status": {
        const live: DeviceLive = {
          online: msg.online,
          lastSeen: msg.lastSeen,
          ...(msg.battery ? { battery: msg.battery } : {}),
          ...(msg.rssi !== undefined ? { rssi: msg.rssi } : {}),
          ...(msg.power ? { power: msg.power } : {}),
          ...(msg.lounge ? { lounge: msg.lounge } : {}),
        };
        this.set({ live: { ...this.snap.live, [msg.deviceId]: live } });
        return;
      }
      case "member.status":
        this.set({
          members: {
            ...this.snap.members,
            [msg.userId]: {
              online: msg.online,
              available: msg.available,
              ...(msg.lounge ? { lounge: msg.lounge } : {}),
            },
          },
        });
        return;
      case "lounge.progress":
        this.set({
          lounge: {
            deviceId: msg.deviceId,
            step: msg.step,
            ...(msg.reason ? { reason: msg.reason } : {}),
            ...(msg.expiresAt ? { expiresAt: msg.expiresAt } : {}),
          },
        });
        return;
      case "voicemail.new":
      case "voicemail.inbox":
        this.set({
          voicemail: {
            seq: (this.snap.voicemail?.seq ?? 0) + 1,
            id: msg.id,
            ...(msg.t === "voicemail.new" ? { deviceId: msg.deviceId } : {}),
            from: msg.from,
          },
        });
        return;
      case "rooms.changed":
        this.set({
          roomPeople: { ...this.snap.roomPeople, [msg.roomId]: msg.people },
          roomsSeq: (this.snap.roomsSeq ?? 0) + 1,
        });
        return;
      case "room.state":
        this.roomState(msg);
        return;
      case "room.idle": {
        const room = this.snap.room;
        if (room?.roomId !== msg.roomId) return;
        this.set({ room: { ...room, idleDropAt: msg.dropAt } });
        return;
      }
      case "room.ended":
        if (this.snap.room && msg.roomId && msg.roomId !== this.snap.room.roomId) return;
        this.endRoom();
        if (msg.reason !== "left" && msg.reason !== "closed") {
          this.set({ error: msg.note ?? roomEndText(msg.reason) });
        }
        return;
      case "room.media":
        if (this.roomAudio?.roomId === msg.roomId) this.roomAudio.handle(msg);
        else this.roomPending.push(msg);
        return;
      case "rtc.config":
        this.ice.set(msg.callId, msg.iceServers);
        return;
      case "rtc.sdp":
      case "rtc.ice": {
        if (msg.peer) {
          if (this.roomAudio?.roomId === msg.callId) this.roomAudio.handle(msg);
          else this.roomPending.push(msg);
          return;
        }
        const audio = this.calls.get(msg.callId);
        if (audio?.media) void this.handleRtc(audio.media, msg);
        else if (audio) audio.pending.push(msg);
        else if (this.currentCallId() === msg.callId) {
          this.calls.set(msg.callId, { mic: this.micCopy(), pending: [msg] });
        }
        return;
      }
      case "call.ringing":
      case "call.state":
        if (msg.t === "call.state" && msg.callId === this.snap.held?.callId) {
          this.heldState(msg);
          return;
        }
        this.apply({ type: "server", msg, now: Date.now() });
        if (msg.t === "call.state" && msg.state === "connecting") this.startMedia(msg.callId);
        return;
    }
  }

  private currentCallId(): string | undefined {
    const c = this.snap.call;
    return "callId" in c ? c.callId : undefined;
  }

  private startMedia(callId: string): void {
    const call = this.snap.call;
    if (!this.mic) return;
    if ((call.phase !== "connecting" && call.phase !== "active") || call.callId !== callId) return;
    const audio = this.calls.get(callId) ?? { mic: this.micCopy(), pending: [] };
    if (audio.media) return;
    this.calls.set(callId, audio);
    audio.media = new CallMedia({
      callId,
      iceServers: this.ice.get(callId) ?? [],
      offerer: call.offerer,
      microphone: audio.mic,
      send: (m) => this.socket.send(m),
      onRemoteStream: (remote) => {
        audio.remote = remote;
        if (this.currentCallId() === callId) this.set({ remote });
      },
      onState: (state) => {
        if (state === "failed") this.set({ error: "Audio connection failed" });
      },
    });
    void audio.media.start().catch((e) => this.set({ error: `Call setup failed: ${e}` }));
    for (const m of audio.pending.splice(0)) void this.handleRtc(audio.media, m);
  }

  private async handleRtc(media: CallMedia, msg: Rtc): Promise<void> {
    try {
      await media.handle(msg);
    } catch (e) {
      console.warn("rtc message failed", e);
    }
  }
}

/** Why you're out of a room, in words. */
export function roomEndText(reason: RoomEndReason): string {
  switch (reason) {
    case "removed":
      return "The host took you out of the room.";
    case "idle":
      return "You were quiet for a long time, so you left the room.";
    case "locked":
      return "That room is locked.";
    case "full":
      return "That room is full.";
    case "denied":
      return "You can't join that room.";
    case "unreachable":
      return "That room's server can't be reached.";
    case "busy":
      return "Finish your call first.";
    case "error":
      return "Something went wrong with the room's audio.";
    default:
      return "You left the room.";
  }
}
