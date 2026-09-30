// Media checks for the live tests: a test-tone WAV for Chromium's fake microphone, and a report on
// the newest RTCPeerConnection of a page (getStats counters, the selected ICE pair, the codec, and
// a WebAudio FFT of the received audio to find a test tone in it).
import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";

/**
 * A mono 16-bit WAV: a `hz` sine at `dbfs`, `onMs` on / `offMs` off (pulsed, so the browser's
 * noise suppression doesn't learn it as stationary noise), `seconds` long (Chromium loops it).
 */
export function writeToneWav(
  file: string,
  { hz = 440, dbfs = -12, onMs = 700, offMs = 300, seconds = 10, rate = 48_000 } = {},
): void {
  const n = seconds * rate;
  const data = Buffer.alloc(n * 2);
  const amp = 32767 * 10 ** (dbfs / 20) * Math.SQRT2; // RMS dBFS → peak
  const period = ((onMs + offMs) * rate) / 1000;
  const on = (onMs * rate) / 1000;
  for (let i = 0; i < n; i++) {
    const s = i % period < on ? amp * Math.sin((2 * Math.PI * hz * i) / rate) : 0;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([header, data]));
}

export interface MediaReport {
  state: string;
  codec: string;
  local: string;
  remote: string;
  packetsSent: number;
  packetsReceived: number;
  bytesReceived: number;
  packetsLost: number;
  jitterMs: number;
  audioLevel: number;
  /** The FFT peak near the watched frequency and how far it stands above the median bin (dB). */
  toneHz: number;
  toneDb: number;
  toneOverMedianDb: number;
}

/** getStats + a ~2 s WebAudio FFT of the received audio of the newest peer connection. */
export async function mediaReport(page: Page, watchHz: number): Promise<MediaReport> {
  return page.evaluate(async (hz: number) => {
    type Rec = { pc: RTCPeerConnection };
    const w = window as unknown as { __olp?: { pcs: Rec[] } };
    const pc = w.__olp?.pcs.at(-1)?.pc;
    if (!pc) throw new Error("no RTCPeerConnection");
    const stats = await pc.getStats();
    // biome-ignore lint/suspicious/noExplicitAny: RTCStats records are loosely typed
    let inbound: any, outbound: any, pairId: string | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    stats.forEach((r: any) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") inbound = r;
      if (r.type === "outbound-rtp" && r.kind === "audio") outbound = r;
      if (r.type === "transport" && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    const pair = pairId ? stats.get(pairId) : undefined;
    const cand = (id?: string) => {
      const c = id ? stats.get(id) : undefined;
      return c
        ? `${c.candidateType}/${c.protocol}${c.relayProtocol ? `(${c.relayProtocol})` : ""}`
        : "?";
    };
    const codec = inbound?.codecId ? stats.get(inbound.codecId)?.mimeType : "?";

    const track = pc.getReceivers().find((r) => r.track?.kind === "audio")?.track;
    let toneHz = 0;
    let toneDb = -200;
    let over = 0;
    if (track) {
      // Chrome only feeds a remote WebRTC track into WebAudio if a media element plays it too.
      const el = new Audio();
      el.srcObject = new MediaStream([track]);
      el.muted = true;
      await el.play().catch(() => {});
      const ctx = new AudioContext();
      await ctx.resume();
      const an = ctx.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      ctx.createMediaStreamSource(new MediaStream([track])).connect(an);
      const bins = new Float32Array(an.frequencyBinCount);
      const binHz = ctx.sampleRate / an.fftSize;
      const lo = Math.floor((hz - 30) / binHz);
      const hi = Math.ceil((hz + 30) / binHz);
      for (let k = 0; k < 12; k++) {
        await new Promise((r) => setTimeout(r, 180));
        an.getFloatFrequencyData(bins);
        let peak = -Infinity;
        let at = 0;
        for (let i = lo; i <= hi; i++) {
          if ((bins[i] as number) > peak) {
            peak = bins[i] as number;
            at = i;
          }
        }
        const sorted = Array.from(bins.slice(1, Math.floor(4000 / binHz))).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] as number;
        if (peak - median > over) {
          over = peak - median;
          toneDb = peak;
          toneHz = at * binHz;
        }
      }
      el.pause();
      await ctx.close();
    }
    return {
      state: pc.connectionState,
      codec: String(codec),
      local: cand(pair?.localCandidateId),
      remote: cand(pair?.remoteCandidateId),
      packetsSent: outbound?.packetsSent ?? 0,
      packetsReceived: inbound?.packetsReceived ?? 0,
      bytesReceived: inbound?.bytesReceived ?? 0,
      packetsLost: inbound?.packetsLost ?? 0,
      jitterMs: Math.round((inbound?.jitter ?? 0) * 1000),
      audioLevel: inbound?.audioLevel ?? 0,
      toneHz: Math.round(toneHz),
      toneDb: Math.round(toneDb),
      toneOverMedianDb: Math.round(over),
    };
  }, watchHz);
}

/** The phone's `AUDIO … key=value …` lines (the periodic log and the `audio` command), parsed. */
export function parseAudioLine(line: string): Record<string, number> | undefined {
  if (!/AUDIO /.test(line)) return undefined;
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\w+)=(-?[\d.]+)/g)) out[m[1] as string] = Number(m[2]);
  return out;
}
