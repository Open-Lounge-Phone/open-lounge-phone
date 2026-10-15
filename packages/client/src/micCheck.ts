/**
 * Mic check for the call screen: a live input level, and a warning when the microphone sends
 * nothing for a few seconds while you're not muted (it's muted in the system, blocked, or
 * unplugged). The level is read from a Web Audio analyser; the rules are pure.
 */

/** RMS of samples in [-1, 1]: 0 = silence, about 0.7 = a full-scale sine. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** How full the meter is (0–1) for an RMS level: dB-scaled from -60 dBFS (empty) to -10 (full). */
export function meterFill(level: number): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  return Math.min(1, Math.max(0, (db + 60) / 50));
}

/** Below this RMS (about -66 dBFS) a microphone counts as sending nothing: even a quiet room is
 * louder; a muted or blocked microphone gives exact zeros. */
export const SILENT_LEVEL = 0.0005;
/** How long the microphone must stay silent, unmuted, before the call screen says so. */
export const SILENT_AFTER_MS = 4000;

export interface SilenceState {
  /** Since when the microphone has been silent while unmuted (undefined = it isn't). */
  since?: number;
}

/**
 * One reading of the level: whether to warn that the microphone is silent. Muting (you chose
 * silence) starts the count over; so does any sound.
 */
export function silenceStep(
  s: SilenceState,
  reading: { level: number; muted: boolean; now: number },
  afterMs = SILENT_AFTER_MS,
): { state: SilenceState; silent: boolean } {
  if (reading.muted || reading.level >= SILENT_LEVEL) return { state: {}, silent: false };
  const since = s.since ?? reading.now;
  return { state: { since }, silent: reading.now - since >= afterMs };
}

/** The input level of a microphone stream, read on demand (`read()`), from a Web Audio analyser. */
export class MicLevel {
  private readonly ctx: AudioContext;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;

  constructor(stream: MediaStream) {
    this.ctx = new AudioContext();
    this.source = this.ctx.createMediaStreamSource(stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    // Not connected to the destination: nothing is played back.
    this.source.connect(this.analyser);
  }

  /** The current RMS level (0–1). */
  read(): number {
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    this.analyser.getFloatTimeDomainData(this.buf);
    return rms(this.buf);
  }

  close(): void {
    this.source.disconnect();
    void this.ctx.close().catch(() => {});
  }
}
