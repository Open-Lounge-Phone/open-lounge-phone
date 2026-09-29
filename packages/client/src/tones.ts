/**
 * North American call-progress tones, synthesized with Web Audio so no assets are needed.
 * (Precise tone plan: dial 350+440 Hz continuous; ringback 440+480 Hz 2s on/4s off;
 * busy 480+620 Hz 0.5s on/off; ring is a warbling bell for the phone's ringer; hold is a soft
 * 440 Hz chirp every 4 s, prompt `hold.tone`, played by your own phone or app while the other
 * side holds you — nothing is sent over the network.)
 */
export type Tone = "none" | "dialtone" | "ringback" | "busy" | "ring" | "hold";

const PLANS: Record<Exclude<Tone, "none">, { freqs: number[]; on: number; off: number }> = {
  dialtone: { freqs: [350, 440], on: 1, off: 0 },
  ringback: { freqs: [440, 480], on: 2, off: 4 },
  busy: { freqs: [480, 620], on: 0.5, off: 0.5 },
  ring: { freqs: [1000, 1250], on: 1.5, off: 3 },
  hold: { freqs: [440], on: 0.25, off: 3.75 },
};

export class TonePlayer {
  private ctx?: AudioContext;
  private stopCurrent?: () => void;
  private current: Tone = "none";

  /** Browsers only allow audio after a user gesture; call this from a click/keydown handler. */
  unlock(): void {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }

  play(tone: Tone): void {
    if (tone === this.current) return;
    this.stopCurrent?.();
    this.stopCurrent = undefined;
    this.current = tone;
    if (tone === "none") return;
    this.unlock();
    const ctx = this.ctx as AudioContext;
    const plan = PLANS[tone];
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const oscs = plan.freqs.map((f) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(gain);
      o.start();
      return o;
    });
    // Ringer warble: alternate the two bell tones quickly instead of mixing them.
    if (tone === "ring") {
      const [a, b] = oscs;
      const warble = ctx.createOscillator();
      warble.frequency.value = 20;
      const depth = ctx.createGain();
      depth.gain.value = 150;
      warble.connect(depth);
      if (a) depth.connect(a.frequency);
      if (b) depth.connect(b.frequency);
      warble.start();
      oscs.push(warble);
    }
    const level = tone === "hold" ? 0.04 : 0.12;
    const period = plan.on + plan.off;
    const schedule = (from: number) => {
      for (let t = from; t < from + 60; t += period) {
        gain.gain.setValueAtTime(level, t);
        if (plan.off > 0) gain.gain.setValueAtTime(0, t + plan.on);
      }
    };
    schedule(ctx.currentTime);
    const refill = setInterval(() => {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      schedule(ctx.currentTime);
    }, 55_000);
    this.stopCurrent = () => {
      clearInterval(refill);
      for (const o of oscs) o.stop();
      gain.disconnect();
    };
  }
}
