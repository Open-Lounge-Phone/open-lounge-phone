/**
 * Leaving a voicemail after an unanswered call, in the browser (the companion and the browser
 * phone): fetch the callee's greeting with the offer's ticket, play it (a recording, or speech
 * for the default sentence), the tone, record until hang-up, then upload. Also the phone's
 * greeting upload. Hardware plays the same steps from pre-recorded prompts.
 */
import { type GreetingStep, greetingScript } from "@openloungephone/core";
import type { GreetingKind, VoicemailOffer } from "@openloungephone/protocol";
import { type Recording, VoicemailRecorder } from "./recorder.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (input, init) => fetch(input, init);

export interface FetchedGreeting {
  kind: GreetingKind;
  /** The recording, for `name` and `custom`. */
  audio?: Blob;
}

/** The callee's greeting; the spoken default whenever there's no recording (or no network). */
export async function fetchGreeting(
  offer: Pick<VoicemailOffer, "ticket">,
  base = "",
  doFetch: Fetch = defaultFetch,
): Promise<FetchedGreeting> {
  try {
    const res = await doFetch(`${base}/api/vm/greeting?ticket=${encodeURIComponent(offer.ticket)}`);
    const kind = res.headers.get("olp-greeting");
    if (res.status === 200 && (kind === "name" || kind === "custom")) {
      return { kind, audio: await res.blob() };
    }
  } catch {
    // Fall back to the spoken default.
  }
  return { kind: "default" };
}

export type UploadResult = { ok: true } | { ok: false; status: number; message: string };

async function upload(
  path: string,
  rec: Recording,
  base: string,
  doFetch: Fetch,
): Promise<UploadResult> {
  try {
    const res = await doFetch(`${base}${path}&durationMs=${Math.round(rec.durationMs)}`, {
      method: "POST",
      headers: { "content-type": rec.blob.type || "audio/webm" },
      body: rec.blob,
    });
    if (res.ok) return { ok: true };
    let message = `failed (${res.status})`;
    try {
      message = String(((await res.json()) as { error?: string }).error ?? message);
    } catch {}
    return { ok: false, status: res.status, message };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

/** Leaves the message with the offer's ticket (single use). */
export function uploadVoicemail(
  offer: Pick<VoicemailOffer, "ticket">,
  rec: Recording,
  base = "",
  doFetch: Fetch = defaultFetch,
): Promise<UploadResult> {
  return upload(`/api/vm/message?ticket=${encodeURIComponent(offer.ticket)}`, rec, base, doFetch);
}

/** A phone saves the greeting it recorded (after `greeting.ticket`). */
export function uploadGreeting(
  ticket: string,
  rec: Recording,
  base = "",
  doFetch: Fetch = defaultFetch,
): Promise<UploadResult> {
  return upload(`/api/vm/greeting?ticket=${encodeURIComponent(ticket)}`, rec, base, doFetch);
}

/** Uploads a call or room recording with the ticket that came with its announcement. */
export function uploadRecording(
  ticket: string,
  rec: Recording,
  base = "",
  doFetch: Fetch = defaultFetch,
): Promise<UploadResult> {
  return upload(`/api/rec/upload?ticket=${encodeURIComponent(ticket)}`, rec, base, doFetch);
}

/** How greetings are voiced: speech, recordings and the tone. */
export interface GreetingVoice {
  say(text: string): Promise<void>;
  play(audio: Blob): Promise<void>;
  tone(): Promise<void>;
  /** Stops whatever is playing. */
  stop(): void;
}

/** Resolves after `ms` or when `p` settles, whichever is first (browsers can drop events). */
const within = (p: Promise<void>, ms: number) =>
  Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

/** The browser's voice: speech synthesis, an <audio> element, and a Web Audio beep. */
export function browserVoice(opts: { volume?: () => number } = {}): GreetingVoice {
  let audioEl: HTMLAudioElement | undefined;
  let ctx: AudioContext | undefined;
  const volume = () => Math.max(0, Math.min(1, opts.volume?.() ?? 1));
  return {
    say(text) {
      if (!("speechSynthesis" in globalThis) || !text.trim()) return Promise.resolve();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.volume = volume();
      const done = new Promise<void>((resolve) => {
        u.onend = () => resolve();
        u.onerror = () => resolve();
      });
      speechSynthesis.speak(u);
      return within(done, 1500 + text.length * 90);
    },
    play(audio) {
      const url = URL.createObjectURL(audio);
      const el = new Audio(url);
      el.volume = volume();
      audioEl = el;
      const done = new Promise<void>((resolve) => {
        el.onended = () => resolve();
        el.onerror = () => resolve();
      });
      void el.play().catch(() => el.onerror?.(new Event("error")));
      return within(done, 35_000).finally(() => URL.revokeObjectURL(url));
    },
    tone() {
      ctx ??= new AudioContext();
      void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1000;
      gain.gain.value = 0.15 * volume();
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
      return new Promise((r) => setTimeout(r, 550));
    },
    stop() {
      if ("speechSynthesis" in globalThis) speechSynthesis.cancel();
      audioEl?.pause();
    },
  };
}

/** Plays the greeting's steps in order; stops early when `cancelled()` turns true. */
export async function playGreeting(
  steps: GreetingStep[],
  greeting: FetchedGreeting,
  voice: GreetingVoice,
  cancelled: () => boolean,
): Promise<void> {
  for (const step of steps) {
    if (cancelled()) return;
    if (step.kind === "say") await voice.say(step.text);
    else if (step.kind === "tone") await voice.tone();
    else if (greeting.audio) await voice.play(greeting.audio);
  }
}

export type LeaveState =
  | { stage: "greeting" }
  | { stage: "recording"; elapsed: number; maxMs: number }
  | { stage: "sending" }
  | { stage: "sent" }
  | { stage: "failed"; message: string; canRetry: boolean }
  | { stage: "cancelled" };

export interface LeaveMessageOptions {
  offer: VoicemailOffer;
  voice: GreetingVoice;
  onState(state: LeaveState): void;
  /** Server origin (default: this page's). */
  base?: string;
  fetch?: Fetch;
}

/**
 * One attempt to leave a message: greeting → tone → recording → (hang up) → upload. `finish()`
 * is "hang up to send"; before the tone it leaves nothing.
 */
export class LeaveMessage {
  private state: LeaveState = { stage: "greeting" };
  private recorder?: VoicemailRecorder;
  private last?: Recording;
  private stopped = false;
  private readonly opts: LeaveMessageOptions;

  constructor(opts: LeaveMessageOptions) {
    this.opts = opts;
  }

  get current(): LeaveState {
    return this.state;
  }

  private set(state: LeaveState): void {
    this.state = state;
    this.opts.onState(state);
  }

  async start(): Promise<void> {
    const { offer, voice } = this.opts;
    this.set({ stage: "greeting" });
    const greeting = await fetchGreeting(offer, this.opts.base, this.opts.fetch);
    if (this.stopped) return;
    await playGreeting(
      greetingScript(greeting.kind, offer.name, offer.prompts),
      greeting,
      voice,
      () => this.stopped,
    );
    if (this.stopped) return;
    const recorder = new VoicemailRecorder(
      {
        onTick: (elapsed) => {
          if (this.state.stage === "recording") {
            this.set({ stage: "recording", elapsed, maxMs: offer.maxMs });
          }
        },
        onDone: (rec) => void this.send(rec),
        onError: (message) => this.set({ stage: "failed", message, canRetry: false }),
      },
      offer.maxMs,
    );
    this.recorder = recorder;
    this.set({ stage: "recording", elapsed: 0, maxMs: offer.maxMs });
    await recorder.start();
  }

  /** Hang up: send what was recorded (nothing, if the tone hadn't sounded yet). */
  finish(): void {
    if (this.state.stage === "greeting") this.cancel();
    else if (this.state.stage === "recording") this.recorder?.stop();
  }

  /** Discard. */
  cancel(): void {
    this.stopped = true;
    this.opts.voice.stop();
    this.recorder?.cancel();
    if (this.state.stage === "greeting" || this.state.stage === "recording") {
      this.set({ stage: "cancelled" });
    }
  }

  /** Sends the last recording again after a network failure. */
  retry(): void {
    if (this.last && this.state.stage === "failed") void this.send(this.last);
  }

  private async send(rec: Recording): Promise<void> {
    this.last = rec;
    this.opts.voice.stop();
    if (rec.blob.size === 0) {
      this.set({ stage: "failed", message: "Nothing was recorded.", canRetry: false });
      return;
    }
    this.set({ stage: "sending" });
    const r = await uploadVoicemail(this.opts.offer, rec, this.opts.base, this.opts.fetch);
    if (r.ok) this.set({ stage: "sent" });
    else {
      // A used or expired ticket, or a refusal, won't get better by trying again.
      const canRetry = r.status === 0 || r.status >= 500 || r.status === 429;
      this.set({ stage: "failed", message: r.message, canRetry });
    }
  }
}
