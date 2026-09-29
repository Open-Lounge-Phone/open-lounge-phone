/** Microphone recording for voicemail and greetings: codec choice and a MediaRecorder wrapper. */

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

export interface Recording {
  blob: Blob;
  durationMs: number;
}

export interface RecorderHandlers {
  onTick(elapsedMs: number): void;
  onDone(recording: Recording): void;
  onError(message: string): void;
}

/** Records from the microphone until `stop()` or `maxMs`. */
export class VoicemailRecorder {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private started = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  private readonly handlers: RecorderHandlers;
  readonly maxMs: number;

  constructor(handlers: RecorderHandlers, maxMs = 60_000) {
    this.handlers = handlers;
    this.maxMs = maxMs;
  }

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  async start(): Promise<void> {
    if (typeof MediaRecorder === "undefined") {
      this.handlers.onError("This browser can't record audio.");
      return;
    }
    const mime = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.handlers.onError(`Microphone unavailable: ${(e as Error).message}`);
      return;
    }
    const recorder = new MediaRecorder(this.stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const durationMs = Math.min(this.maxMs, Date.now() - this.started);
      this.cleanup();
      const type = recorder.mimeType || mime || "audio/webm";
      this.handlers.onDone({ blob: new Blob(chunks, { type }), durationMs });
    };
    this.recorder = recorder;
    this.started = Date.now();
    recorder.start(1000);
    this.ticker = setInterval(() => this.handlers.onTick(Date.now() - this.started), 250);
    this.limit = setTimeout(() => this.stop(), this.maxMs);
  }

  stop(): void {
    if (this.recorder?.state === "recording") this.recorder.stop();
  }

  /** Stops without delivering a recording. */
  cancel(): void {
    if (this.recorder) this.recorder.onstop = () => this.cleanup();
    this.stop();
    this.cleanup();
  }

  private cleanup(): void {
    clearInterval(this.ticker);
    clearTimeout(this.limit);
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
  }
}
