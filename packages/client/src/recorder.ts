/**
 * Microphone recording for voicemail and greetings. Messages are 8 kHz 16-bit mono WAV, the
 * format every phone can play (the hardware phone has no Opus or AAC decoder; its calls are
 * 8 kHz anyway). Two minutes is 1.9 MB, under the 2 MB upload limit. Call recordings
 * (`CallRecorder`) still use MediaRecorder, see `pickRecordingMime`.
 */
import { MIC_NEEDS_HTTPS } from "./media.ts";

/** Preference order: Opus in WebM (Chrome, Firefox), Opus in Ogg, then AAC in MP4 (Safari). */
const CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/mp4",
];

export function pickRecordingMime(isTypeSupported: (type: string) => boolean): string | undefined {
  return CANDIDATES.find((t) => {
    try {
      return isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/** The rate voicemail and greetings are stored at (the phones' call rate). */
export const MESSAGE_RATE = 8000;

/**
 * Resamples `input` (at `inRate`) to `outRate`: each output sample is the mean of the input
 * samples it covers (a box low-pass, enough for speech going down to 8 kHz), or the nearest
 * sample when going up.
 */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input.slice();
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio);
    const to = Math.max(from + 1, Math.min(input.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j] as number;
    out[i] = sum / (to - from);
  }
  return out;
}

/** A 16-bit PCM mono WAV file of `samples` (-1..1, clipped) at `rate`. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return bytes;
}

export interface Recording {
  blob: Blob;
  durationMs: number;
}

export interface RecorderHandlers {
  onTick(elapsedMs: number): void;
  onDone(recording: Recording): void;
  onError(message: string): void;
}

/** Records from the microphone until `stop()` or `maxMs`, as an 8 kHz WAV. */
export class VoicemailRecorder {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: ScriptProcessorNode;
  private chunks: Float32Array[] = [];
  private started = 0;
  private active = false;
  private ticker?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  private readonly handlers: RecorderHandlers;
  readonly maxMs: number;

  constructor(handlers: RecorderHandlers, maxMs = 60_000) {
    this.handlers = handlers;
    this.maxMs = maxMs;
  }

  get recording(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    if (typeof AudioContext === "undefined") {
      this.handlers.onError("This browser can't record audio.");
      return;
    }
    try {
      if (!globalThis.navigator?.mediaDevices) throw new Error(MIC_NEEDS_HTTPS);
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.handlers.onError(`Microphone unavailable: ${(e as Error).message}`);
      return;
    }
    const context = new AudioContext();
    const source = context.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but runs everywhere without a separate worklet file.
    const node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (this.active) this.chunks.push(e.inputBuffer.getChannelData(0).slice());
    };
    source.connect(node);
    node.connect(context.destination); // outputs silence; needed for the node to run
    if (context.state === "suspended") await context.resume().catch(() => {});
    this.context = context;
    this.node = node;
    this.chunks = [];
    this.active = true;
    this.started = Date.now();
    this.ticker = setInterval(() => this.handlers.onTick(Date.now() - this.started), 250);
    this.limit = setTimeout(() => this.stop(), this.maxMs);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    const rate = this.context?.sampleRate ?? MESSAGE_RATE;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(total);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    // Never longer than the limit (the last buffer can run past it).
    const samples = resample(all, rate, MESSAGE_RATE).subarray(
      0,
      (this.maxMs * MESSAGE_RATE) / 1000,
    );
    this.cleanup();
    const wav = encodeWav(samples, MESSAGE_RATE);
    this.handlers.onDone({
      blob: new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }),
      durationMs: Math.round((samples.length * 1000) / MESSAGE_RATE),
    });
  }

  /** Stops without delivering a recording. */
  cancel(): void {
    this.active = false;
    this.cleanup();
  }

  private cleanup(): void {
    clearInterval(this.ticker);
    clearTimeout(this.limit);
    this.chunks = [];
    this.node?.disconnect();
    this.node = undefined;
    void this.context?.close().catch(() => {});
    this.context = undefined;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
  }
}
