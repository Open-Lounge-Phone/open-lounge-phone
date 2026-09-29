import {
  CallMedia,
  getMicrophone,
  ProtocolSocket,
  type SocketStatus,
  socketUrl,
  TonePlayer,
} from "@openloungephone/client";
import {
  type AppToServer,
  decodeServerToApp,
  type IceServer,
  PROTOCOL_VERSION,
  type ServerToApp,
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

export interface Snapshot {
  status: SocketStatus;
  call: CallView;
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
  /** Latest `voicemail.new`; `seq` changes on every announcement. */
  voicemail?: { seq: number; id: string; deviceId: string; from: string };
}

type Rtc = Extract<ServerToApp, { t: "rtc.sdp" | "rtc.ice" }>;

const ENDED_DISPLAY_MS = 3000;
const UNAUTHORIZED = 4401;
const BAD_HANDSHAKE = 4400;

/**
 * The app's live link to the server: socket, device presence, and the (single) current call
 * including microphone and WebRTC media. React subscribes via `subscribe` / `getSnapshot`.
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
  private pending: Rtc[] = [];
  private media?: CallMedia;
  private mic?: MediaStream;
  private dismissTimer?: ReturnType<typeof setTimeout>;

  constructor(token: string, householdId: string, onUnauthorized: () => void) {
    this.socket = new ProtocolSocket<ServerToApp, AppToServer>({
      url: socketUrl(`/ws/app?household=${encodeURIComponent(householdId)}`),
      decode: decodeServerToApp,
      onOpen: (send) =>
        send({ t: "app.hello", proto: PROTOCOL_VERSION, token, household: householdId }),
      onMessage: (msg) => this.onMessage(msg),
      onStatus: (status, detail) => {
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
    this.teardown();
    this.tones.play("none");
    this.socket.close();
  }

  // --- user actions (call from click handlers so audio/mic permissions apply) ---

  async dial(deviceId: string, label: string): Promise<void> {
    const phase = this.snap.call.phase;
    if (phase !== "idle" && phase !== "ended") return;
    this.tones.unlock();
    if (!(await this.acquireMic())) return;
    this.apply({ type: "dial", label, deviceId });
    if (!this.socket.send({ t: "call.dial", deviceId })) {
      this.apply({ type: "hangup" });
      this.set({ error: "Not connected to the server" });
    }
  }

  /** Grown-up, app-to-app call. The server refuses it unless they're online and available. */
  async callUser(userId: string, label: string): Promise<void> {
    const phase = this.snap.call.phase;
    if (phase !== "idle" && phase !== "ended") return;
    this.tones.unlock();
    if (!(await this.acquireMic())) return;
    this.apply({ type: "dial", label, person: true });
    if (!this.socket.send({ t: "call.user", userId })) {
      this.apply({ type: "hangup" });
      this.set({ error: "Not connected to the server" });
    }
  }

  /** Whether you're taking app-to-app calls; the server remembers it. */
  setAvailable(available: boolean): boolean {
    return this.socket.send({ t: "presence.set", available });
  }

  /** Take over a Lounge phone (from its QR code); the phone then asks for the key proof. */
  claimLounge(deviceId: string, nonce: string): boolean {
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

  toggleMute(): void {
    const muted = !this.snap.muted;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    this.set({ muted });
  }

  dismiss(): void {
    this.apply({ type: "dismiss" });
  }

  clearError(): void {
    this.set({ error: undefined });
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

  private apply(event: CallEvent): void {
    const before = this.snap.call;
    const { view, decline } = callStep(before, event);
    if (decline) this.socket.send({ t: "call.hangup", callId: decline });
    if (view === before) return;
    this.tones.play(toneFor(view));
    if (view.phase === "ended" || view.phase === "idle") this.teardown();
    clearTimeout(this.dismissTimer);
    // A quiet-hours refusal stays up so the caller can record a message.
    if (view.phase === "ended" && !canLeaveVoicemail(view)) {
      this.dismissTimer = setTimeout(() => this.dismiss(), ENDED_DISPLAY_MS);
    }
    this.set({ call: view });
  }

  private onMessage(msg: ServerToApp): void {
    switch (msg.t) {
      case "app.ready":
      case "pong":
        return;
      case "connections.changed":
        this.set({ connectionsSeq: (this.snap.connectionsSeq ?? 0) + 1 });
        return;
      case "error":
        this.set({ error: msg.message });
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
        this.set({
          voicemail: {
            seq: (this.snap.voicemail?.seq ?? 0) + 1,
            id: msg.id,
            deviceId: msg.deviceId,
            from: msg.from,
          },
        });
        return;
      case "rtc.config":
        this.ice.set(msg.callId, msg.iceServers);
        return;
      case "rtc.sdp":
      case "rtc.ice":
        if (this.media && this.currentCallId() === msg.callId) void this.handleRtc(msg);
        else if (this.currentCallId() === msg.callId) this.pending.push(msg);
        return;
      case "call.ringing":
      case "call.state":
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
    if (this.media || !this.mic) return;
    if ((call.phase !== "connecting" && call.phase !== "active") || call.callId !== callId) return;
    this.media = new CallMedia({
      callId,
      iceServers: this.ice.get(callId) ?? [],
      offerer: call.offerer,
      microphone: this.mic,
      send: (m) => this.socket.send(m),
      onRemoteStream: (remote) => this.set({ remote }),
      onState: (state) => {
        if (state === "failed") this.set({ error: "Audio connection failed" });
      },
    });
    void this.media.start().catch((e) => this.set({ error: `Call setup failed: ${e}` }));
    for (const m of this.pending.splice(0)) void this.handleRtc(m);
  }

  private async handleRtc(msg: Rtc): Promise<void> {
    try {
      await this.media?.handle(msg);
    } catch (e) {
      console.warn("rtc message failed", e);
    }
  }

  private teardown(): void {
    this.media?.close();
    this.media = undefined;
    this.pending = [];
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    this.mic = undefined;
    this.ice.clear();
    if (this.snap.remote || this.snap.muted) this.set({ remote: undefined, muted: false });
  }
}
