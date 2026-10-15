import type { IceServer } from "@openloungephone/protocol";
import {
  inboundAudio,
  type Link,
  type LinkState,
  linkStep,
  NEW_LINK,
  NEW_QUALITY,
  type Quality,
  qualityStep,
} from "./callHealth.ts";

type Signal =
  | { t: "rtc.sdp"; callId: string; type: "offer" | "answer"; sdp: string }
  | {
      t: "rtc.ice";
      callId: string;
      candidate: string | null;
      sdpMid?: string | null;
      sdpMLineIndex?: number | null;
    };

export interface CallMediaOptions {
  callId: string;
  iceServers: IceServer[];
  /** The party that placed the call sends the offer. */
  offerer: boolean;
  microphone: MediaStream;
  send(msg: Signal): void;
  onRemoteStream(stream: MediaStream): void;
  onState?(state: RTCPeerConnectionState): void;
  /**
   * The connection's health: `reconnecting` when it dropped (the offerer restarts ICE), back to
   * `connected`, or `lost` when it couldn't recover in time (end the call: `call.hangup` with
   * `lost`).
   */
  onLink?(state: LinkState): void;
  /** Packet loss or jitter made the incoming audio poor (true), or it's fine again (false). */
  onQuality?(poor: boolean): void;
}

/** How often the connection's health and the incoming audio's statistics are looked at. */
const HEALTH_TICK_MS = 1000;
const STATS_EVERY_MS = 2000;

/**
 * Turns on Opus DTX (`usedtx=1`): during silence the sender stops sending audio frames, so a
 * relayed (TURN) call costs almost nothing while nobody speaks. Each side marks its own
 * description, so both directions use it.
 */
export function withOpusDtx(sdp: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const opus = new Set(
    lines
      .map((l) => /^a=rtpmap:(\d+) opus\/48000/i.exec(l)?.[1])
      .filter((pt): pt is string => pt !== undefined),
  );
  const withFmtp = new Set<string>();
  const out = lines.map((l) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (!m || !opus.has(m[1] as string)) return l;
    withFmtp.add(m[1] as string);
    if (/(^|;)\s*usedtx=/.test(m[2] as string)) return l.replace(/usedtx=\d/, "usedtx=1");
    return `${l};usedtx=1`;
  });
  // Opus without any fmtp line: add one right after its rtpmap.
  return out
    .flatMap((l) => {
      const pt = /^a=rtpmap:(\d+) opus\/48000/i.exec(l)?.[1];
      return pt && !withFmtp.has(pt) ? [l, `a=fmtp:${pt} usedtx=1`] : [l];
    })
    .join(eol);
}

/** Audio-only peer connection for one call, driven by relayed `rtc.*` messages. */
export class CallMedia {
  readonly pc: RTCPeerConnection;
  private readonly opts: CallMediaOptions;
  private pendingIce: RTCIceCandidateInit[] = [];
  private link: Link = NEW_LINK;
  private quality: Quality = NEW_QUALITY;
  private healthTimer?: ReturnType<typeof setInterval>;
  private lastStats = 0;

  constructor(opts: CallMediaOptions) {
    this.opts = opts;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    for (const track of opts.microphone.getAudioTracks()) this.pc.addTrack(track, opts.microphone);
    this.pc.onicecandidate = (e) =>
      opts.send({
        t: "rtc.ice",
        callId: opts.callId,
        candidate: e.candidate?.candidate ?? null,
        sdpMid: e.candidate?.sdpMid ?? null,
        sdpMLineIndex: e.candidate?.sdpMLineIndex ?? null,
      });
    this.pc.ontrack = (e) => opts.onRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
    this.pc.onconnectionstatechange = () => {
      opts.onState?.(this.pc.connectionState);
      this.linkEvent({ type: "pc", state: this.pc.connectionState });
    };
    if (opts.onLink || opts.onQuality) {
      this.healthTimer = setInterval(() => this.health(), HEALTH_TICK_MS);
    }
  }

  /** The connection's state as `onLink` last reported it. */
  get linkState(): LinkState {
    return this.link.state;
  }

  private linkEvent(e: Parameters<typeof linkStep>[1]): void {
    const before = this.link.state;
    const r = linkStep(this.link, e, Date.now(), this.opts.offerer);
    this.link = r.link;
    if (r.restart) void this.restartIce();
    if (r.link.state !== before) {
      if (r.link.state !== "connected" && this.quality.poor) {
        this.quality = { ...this.quality, poor: false };
        this.opts.onQuality?.(false);
      }
      this.opts.onLink?.(r.link.state);
    }
  }

  private health(): void {
    this.linkEvent({ type: "tick" });
    const now = Date.now();
    if (this.link.state !== "connected" || !this.opts.onQuality) return;
    if (now - this.lastStats < STATS_EVERY_MS) return;
    this.lastStats = now;
    void this.pc.getStats().then(
      (report) => {
        const sample = inboundAudio(report, Date.now());
        if (!sample || this.link.state !== "connected") return;
        const was = this.quality.poor;
        this.quality = qualityStep(this.quality, sample);
        if (this.quality.poor !== was) this.opts.onQuality?.(this.quality.poor);
      },
      () => {},
    );
  }

  /** The party that offered restarts ICE: a new offer with fresh credentials, on the same call. */
  private async restartIce(): Promise<void> {
    try {
      const created = await this.pc.createOffer({ iceRestart: true });
      const offer = { type: created.type, sdp: withOpusDtx(created.sdp ?? "") };
      await this.pc.setLocalDescription(offer);
      this.opts.send({ t: "rtc.sdp", callId: this.opts.callId, type: "offer", sdp: offer.sdp });
    } catch {
      // Closed meanwhile, or a negotiation in progress: the next tick tries again.
    }
  }

  /** Call once both sides have `rtc.config`; the offerer starts negotiation. */
  async start(): Promise<void> {
    if (!this.opts.offerer) return;
    const created = await this.pc.createOffer();
    const offer = { type: created.type, sdp: withOpusDtx(created.sdp ?? "") };
    await this.pc.setLocalDescription(offer);
    this.opts.send({ t: "rtc.sdp", callId: this.opts.callId, type: "offer", sdp: offer.sdp });
  }

  async handle(msg: Signal): Promise<void> {
    if (msg.t === "rtc.sdp") {
      await this.pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp });
      for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
      if (msg.type === "offer") {
        const created = await this.pc.createAnswer();
        const answer = { type: created.type, sdp: withOpusDtx(created.sdp ?? "") };
        await this.pc.setLocalDescription(answer);
        this.opts.send({ t: "rtc.sdp", callId: this.opts.callId, type: "answer", sdp: answer.sdp });
      }
      return;
    }
    const init: RTCIceCandidateInit | null =
      msg.candidate === null
        ? null
        : {
            candidate: msg.candidate,
            sdpMid: msg.sdpMid ?? null,
            sdpMLineIndex: msg.sdpMLineIndex ?? null,
          };
    if (!init) return;
    if (this.pc.remoteDescription) await this.pc.addIceCandidate(init);
    else this.pendingIce.push(init);
  }

  close(): void {
    clearInterval(this.healthTimer);
    this.pc.close();
  }
}

/**
 * Microphone with the browser's echo cancellation and noise suppression on: the one chosen on
 * this device (`deviceId`, see audioPrefs.ts) if it's still there, else the system default.
 */
export function getMicrophone(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    },
    video: false,
  });
}
