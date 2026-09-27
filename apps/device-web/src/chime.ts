// A short, soft two-note chime for "you have a new message". Browsers only allow audio after a
// user gesture, so call `unlockChime()` from a key/handset interaction first.
let ctx: AudioContext | undefined;

export function unlockChime(): void {
  ctx ??= new AudioContext();
  void ctx.resume();
}

export function playChime(): void {
  const audio = ctx;
  if (audio?.state !== "running") return;
  const start = audio.currentTime + 0.02;
  [660, 880].forEach((freq, i) => {
    const t = start + i * 0.18;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.08, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}
