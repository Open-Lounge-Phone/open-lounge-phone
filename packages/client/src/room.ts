// A room's audio in the browser (companion and browser phone). How it travels depends on the
// room's server (`room.state.media`):
// - `mesh`: one peer connection per other participant (≤ 4 people). The one with the smaller
//   participant id offers. End-to-end encrypted (DTLS-SRTP between the people themselves).
// - `sfu`: one peer connection to the room owner's Cloudflare Realtime SFU, driven by that server
//   over `room.media`: we offer our microphone once; it offers others' audio (we answer) and asks
//   us to `close` slots when the active speakers change (we stop them and offer again).
// - `livekit`: the room owner's LiveKit server, with the join token from `room.state`; we listen
//   to whom `room.state.forward` lists.
// Relayed rooms are encrypted in transit, not end to end. We also tell the server when we're
// speaking (`room.talk`), which picks the active speakers a relay forwards in big rooms.
import type { IceServer, ServerToApp } from "@openloungephone/protocol";
import { withOpusDtx } from "./media.ts";

type RoomState = Extract<ServerToApp, { t: "room.state" }>;
type RoomMedia = Extract<ServerToApp, { t: "room.media" }>;
type Rtc = Extract<ServerToApp, { t: "rtc.sdp" | "rtc.ice" }>;

/** What a room's audio sends to the server. */
export type RoomOut =
  | { t: "room.media"; roomId: string; type: "offer" | "answer"; sdp: string }
  | { t: "room.talk"; roomId: string; speaking: boolean }
  | { t: "rtc.sdp"; callId: string; type: "offer" | "answer"; sdp: string; peer: string }
  | {
      t: "rtc.ice";
      callId: string;
      candidate: string | null;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
      peer: string;
    };

export interface RoomAudioOptions {
  roomId: string;
  iceServers: IceServer[];
  microphone: MediaStream;
  send(msg: RoomOut): void;
  /** The room's audio path is up (hang up any calls that merged into it now). */
  onConnected?(): void;
  /** Who is audible now (participant ids, or slot ids on a relay), for the UI. */
  onAudible?(count: number): void;
  /** Output volume 0–1. */
  volume?: number;
  /** Every remote audio stream as it starts playing (e.g. for recording the room). */
  onStream?(stream: MediaStream): void;
}

/** Voice activity from the microphone's level, with hysteresis. */
class Vad {
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private speaking = false;
  private loudSince = 0;
  private quietSince = 0;

  constructor(mic: MediaStream, onChange: (speaking: boolean) => void, muted: () => boolean) {
    const Ctx = globalThis.AudioContext;
    if (!Ctx) return;
    try {
      this.ctx = new Ctx();
      const source = this.ctx.createMediaStreamSource(mic);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        const loud = !muted() && rms > 0.02;
        if (loud) {
          this.quietSince = 0;
          this.loudSince ||= now;
        } else {
          this.loudSince = 0;
          this.quietSince ||= now;
        }
        // Speaking after 200 ms of voice; silent after 800 ms of quiet.
        if (!this.speaking && loud && now - this.loudSince >= 200) {
          this.speaking = true;
          onChange(true);
        } else if (this.speaking && !loud && now - this.quietSince >= 800) {
          this.speaking = false;
          onChange(false);
        }
      }, 100);
    } catch {
      // No Web Audio: the server just sees nobody speaking (join order decides).
    }
  }

  close(): void {
    clearInterval(this.timer);
    void this.ctx?.close().catch(() => {});
  }
}

/** Plays remote streams through hidden audio elements (one per stream). */
class Speakers {
  private readonly els = new Map<string, HTMLAudioElement>();
  private volume: number;

  constructor(volume = 1) {
    this.volume = volume;
  }

  play(key: string, stream: MediaStream): void {
    if (typeof Audio === "undefined") return;
    let el = this.els.get(key);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      el.volume = this.volume;
      this.els.set(key, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    void el.play().catch(() => {});
  }

  mute(key: string, muted: boolean): void {
    const el = this.els.get(key);
    if (el) el.muted = muted;
  }

  drop(key: string): void {
    const el = this.els.get(key);
    if (!el) return;
    el.srcObject = null;
    this.els.delete(key);
  }

  setVolume(v: number): void {
    this.volume = v;
    for (const el of this.els.values()) el.volume = v;
  }

  get count(): number {
    return this.els.size;
  }

  clear(): void {
    for (const key of [...this.els.keys()]) this.drop(key);
  }
}

interface MeshLink {
  pc: RTCPeerConnection;
  pendingIce: RTCIceCandidateInit[];
}

export class RoomAudio {
  readonly roomId: string;
  private readonly opts: RoomAudioOptions;
  private readonly speakers: Speakers;
  private readonly vad: Vad;
  private media?: RoomState["media"];
  private you?: string;
  private muted = false;
  private connected = false;
  private closed = false;
  // mesh
  private readonly links = new Map<string, MeshLink>();
  // sfu
  private pc?: RTCPeerConnection;
  private chain: Promise<void> = Promise.resolve();
  // livekit
  private lk?: {
    room: import("livekit-client").Room;
    forward: string[];
  };

  constructor(opts: RoomAudioOptions) {
    this.opts = opts;
    this.roomId = opts.roomId;
    this.speakers = new Speakers(opts.volume ?? 1);
    this.vad = new Vad(
      opts.microphone,
      (speaking) => opts.send({ t: "room.talk", roomId: this.roomId, speaking }),
      () => this.muted,
    );
  }

  /** Plays someone's audio (and hands it to `onStream`). */
  private hear(key: string, stream: MediaStream): void {
    this.speakers.play(key, stream);
    this.opts.onStream?.(stream);
  }

  /** Our own microphone on or off (the server is told by the app with `room.mute`). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const t of this.opts.microphone.getAudioTracks()) t.enabled = !muted;
  }

  setVolume(v: number): void {
    this.speakers.setVolume(v);
  }

  private markConnected(): void {
    if (this.connected) return;
    this.connected = true;
    this.opts.onConnected?.();
  }

  /** Every `room.state`: who's there, how audio travels, whom we hear. */
  update(state: RoomState): void {
    if (this.closed || state.roomId !== this.roomId) return;
    const first = this.media === undefined;
    this.media = state.media;
    this.you = state.you;
    const me = state.participants.find((p) => p.id === state.you);
    if (me && me.muted !== this.muted) this.setMuted(me.muted);
    if (state.media === "mesh") this.updateMesh(state);
    else if (state.media === "sfu" && first) this.startSfu();
    else if (state.media === "livekit") void this.updateLivekit(state);
    // Alone in the room: nothing to wait for.
    if (state.participants.length <= 1) this.markConnected();
  }

  /** `room.media` from the relay, or a mesh participant's `rtc.*`. */
  handle(msg: RoomMedia | Rtc): void {
    if (this.closed) return;
    if (msg.t === "room.media") {
      this.chain = this.chain
        .then(() => this.sfuMessage(msg))
        .catch((e) => console.warn("room media", e));
      return;
    }
    if (!msg.peer) return;
    void this.meshMessage(msg).catch((e) => console.warn("room rtc", e));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.vad.close();
    for (const l of this.links.values()) l.pc.close();
    this.links.clear();
    this.pc?.close();
    void this.lk?.room.disconnect();
    this.speakers.clear();
  }

  // --- mesh -----------------------------------------------------------------------------

  private updateMesh(state: RoomState): void {
    const others = state.participants.filter((p) => p.id !== state.you);
    const ids = new Set(others.map((p) => p.id));
    for (const [id, link] of this.links) {
      if (!ids.has(id)) {
        link.pc.close();
        this.links.delete(id);
        this.speakers.drop(id);
      }
    }
    for (const p of others) {
      if (!this.links.has(p.id)) {
        const link = this.meshLink(p.id);
        // The smaller id offers, so exactly one side does.
        if ((state.you ?? "") < p.id) void this.meshOffer(p.id, link);
      }
      // A muted participant (by the host) isn't heard here either.
      this.speakers.mute(p.id, p.muted);
    }
    this.opts.onAudible?.(this.speakers.count);
  }

  private meshLink(peer: string): MeshLink {
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers });
    for (const t of this.opts.microphone.getAudioTracks()) pc.addTrack(t, this.opts.microphone);
    const link: MeshLink = { pc, pendingIce: [] };
    pc.onicecandidate = (e) =>
      this.opts.send({
        t: "rtc.ice",
        callId: this.roomId,
        candidate: e.candidate?.candidate ?? null,
        sdpMid: e.candidate?.sdpMid ?? null,
        sdpMLineIndex: e.candidate?.sdpMLineIndex ?? null,
        peer,
      });
    pc.ontrack = (e) => {
      this.hear(peer, e.streams[0] ?? new MediaStream([e.track]));
      this.opts.onAudible?.(this.speakers.count);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.markConnected();
    };
    this.links.set(peer, link);
    return link;
  }

  private async meshOffer(peer: string, link: MeshLink): Promise<void> {
    const offer = await link.pc.createOffer();
    const sdp = withOpusDtx(offer.sdp ?? "");
    await link.pc.setLocalDescription({ type: "offer", sdp });
    this.opts.send({ t: "rtc.sdp", callId: this.roomId, type: "offer", sdp, peer });
  }

  private async meshMessage(msg: Rtc): Promise<void> {
    const peer = msg.peer as string;
    const link = this.links.get(peer) ?? this.meshLink(peer);
    if (msg.t === "rtc.sdp") {
      await link.pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp });
      for (const c of link.pendingIce.splice(0)) await link.pc.addIceCandidate(c);
      if (msg.type === "offer") {
        const answer = await link.pc.createAnswer();
        const sdp = withOpusDtx(answer.sdp ?? "");
        await link.pc.setLocalDescription({ type: "answer", sdp });
        this.opts.send({ t: "rtc.sdp", callId: this.roomId, type: "answer", sdp, peer });
      }
      return;
    }
    if (msg.candidate === null) return;
    const init: RTCIceCandidateInit = {
      candidate: msg.candidate,
      sdpMid: msg.sdpMid ?? null,
      sdpMLineIndex: msg.sdpMLineIndex ?? null,
    };
    if (link.pc.remoteDescription) await link.pc.addIceCandidate(init);
    else link.pendingIce.push(init);
  }

  // --- the relay (Cloudflare SFU) -------------------------------------------------------------

  private startSfu(): void {
    const pc = new RTCPeerConnection({
      iceServers: this.opts.iceServers,
      bundlePolicy: "max-bundle",
    });
    this.pc = pc;
    const track = this.opts.microphone.getAudioTracks()[0];
    if (track) pc.addTransceiver(track, { direction: "sendonly" });
    pc.ontrack = (e) => {
      const key = e.transceiver.mid ?? String(this.speakers.count);
      this.hear(key, new MediaStream([e.track]));
      this.opts.onAudible?.(this.speakers.count);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") this.markConnected();
    };
    this.chain = this.chain.then(async () => {
      const offer = await pc.createOffer();
      const sdp = withOpusDtx(offer.sdp ?? "");
      await pc.setLocalDescription({ type: "offer", sdp });
      this.opts.send({ t: "room.media", roomId: this.roomId, type: "offer", sdp });
    });
  }

  private async sfuMessage(msg: RoomMedia): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (msg.type === "answer" && msg.sdp) {
      await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      return;
    }
    if (msg.type === "offer" && msg.sdp) {
      await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
      const answer = await pc.createAnswer();
      const sdp = withOpusDtx(answer.sdp ?? "");
      await pc.setLocalDescription({ type: "answer", sdp });
      this.opts.send({ t: "room.media", roomId: this.roomId, type: "answer", sdp });
      return;
    }
    if (msg.type === "close" && msg.mids) {
      // Stop those slots and offer; the relay answers and reuses them later.
      for (const t of pc.getTransceivers()) {
        if (t.mid && msg.mids.includes(t.mid)) {
          t.stop();
          this.speakers.drop(t.mid);
        }
      }
      const offer = await pc.createOffer();
      const sdp = withOpusDtx(offer.sdp ?? "");
      await pc.setLocalDescription({ type: "offer", sdp });
      this.opts.send({ t: "room.media", roomId: this.roomId, type: "offer", sdp });
      this.opts.onAudible?.(this.speakers.count);
    }
  }

  // --- LiveKit ------------------------------------------------------------------------------

  private async updateLivekit(state: RoomState): Promise<void> {
    const forward = state.forward ?? [];
    if (!this.lk) {
      if (!state.livekit) return;
      const lk = await import("livekit-client");
      const room = new lk.Room({ adaptiveStream: false, dynacast: false });
      this.lk = { room, forward };
      room.on(lk.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== "audio") return;
        this.hear(participant.identity, new MediaStream([track.mediaStreamTrack]));
        this.opts.onAudible?.(this.speakers.count);
      });
      room.on(lk.RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => {
        this.speakers.drop(participant.identity);
      });
      room.on(lk.RoomEvent.TrackPublished, () => this.livekitSubscriptions());
      room.on(lk.RoomEvent.Connected, () => this.markConnected());
      await room.connect(state.livekit.url, state.livekit.token, { autoSubscribe: false });
      const track = this.opts.microphone.getAudioTracks()[0];
      if (track) {
        await room.localParticipant.publishTrack(track, {
          source: lk.Track.Source.Microphone,
          dtx: true,
        });
      }
    }
    this.lk.forward = forward;
    this.livekitSubscriptions();
  }

  /** Listens to exactly whom the server forwards (the top speakers in big rooms). */
  private livekitSubscriptions(): void {
    const lk = this.lk;
    if (!lk) return;
    for (const participant of lk.room.remoteParticipants.values()) {
      const wanted = lk.forward.includes(participant.identity);
      for (const pub of participant.audioTrackPublications.values()) pub.setSubscribed(wanted);
    }
  }

  /** Participant id of this client in the room (after the first `room.state`). */
  get participant(): string | undefined {
    return this.you;
  }
}
