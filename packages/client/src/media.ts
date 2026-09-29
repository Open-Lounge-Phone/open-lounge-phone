import type { IceServer } from "@openloungephone/protocol";

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
}

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
    this.pc.onconnectionstatechange = () => opts.onState?.(this.pc.connectionState);
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
    this.pc.close();
  }
}

/** Microphone with the browser's echo cancellation and noise suppression on. */
export function getMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}
