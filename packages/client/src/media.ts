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
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.opts.send({ t: "rtc.sdp", callId: this.opts.callId, type: "offer", sdp: offer.sdp ?? "" });
  }

  async handle(msg: Signal): Promise<void> {
    if (msg.t === "rtc.sdp") {
      await this.pc.setRemoteDescription({ type: msg.type, sdp: msg.sdp });
      for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
      if (msg.type === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.opts.send({
          t: "rtc.sdp",
          callId: this.opts.callId,
          type: "answer",
          sdp: answer.sdp ?? "",
        });
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
