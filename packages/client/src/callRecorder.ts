/**
 * Recording a call or a room on the recording side's own client (docs/security-model.md): the
 * server hands this client a ticket together with the announcement every party gets; the client
 * mixes what it sends and what it hears, records until the call ends (or `maxMs`), and uploads.
 * The server never hears 1:1 calls: this is the only way a recording is made.
 */
import { pickRecordingMime } from "./recorder.ts";
import { type UploadResult, uploadRecording } from "./voicemail.ts";

export interface CallRecorderOptions {
  ticket: string;
  maxMs: number;
  base?: string;
  onDone?(result: UploadResult): void;
}

export class CallRecorder {
  private readonly opts: CallRecorderOptions;
  private ctx?: AudioContext;
  private dest?: MediaStreamAudioDestinationNode;
  private recorder?: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly seen = new Set<string>();
  private readonly pending: MediaStream[] = [];
  private started = 0;
  private limit?: ReturnType<typeof setTimeout>;
  private finished = false;

  constructor(opts: CallRecorderOptions) {
    this.opts = opts;
  }

  /** Adds a stream to the mix (the microphone, the other side, each room participant). */
  add(stream: MediaStream | undefined): void {
    if (!stream || this.seen.has(stream.id) || stream.getAudioTracks().length === 0) return;
    this.seen.add(stream.id);
    if (!this.ctx || !this.dest) {
      this.pending.push(stream);
      return;
    }
    try {
      this.ctx.createMediaStreamSource(stream).connect(this.dest);
    } catch {
      // A stream that can't be mixed (ended already) is left out.
    }
  }

  /** Starts recording. False if this browser can't record (then nothing is uploaded). */
  start(): boolean {
    const Ctx = globalThis.AudioContext;
    if (!Ctx || typeof MediaRecorder === "undefined") return false;
    this.ctx = new Ctx();
    this.dest = this.ctx.createMediaStreamDestination();
    for (const s of this.pending.splice(0)) {
      this.seen.delete(s.id);
      this.add(s);
    }
    const mime = pickRecordingMime((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(this.dest.stream, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 32_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    recorder.onstop = () => void this.upload(recorder.mimeType || mime || "audio/webm");
    this.recorder = recorder;
    this.started = Date.now();
    recorder.start(1000);
    this.limit = setTimeout(() => this.stop(), this.opts.maxMs);
    return true;
  }

  /** Stops (the call ended, or the recording was withdrawn) and uploads what was recorded. */
  stop(): void {
    clearTimeout(this.limit);
    if (this.recorder?.state === "recording") this.recorder.stop();
    else if (!this.finished) this.cleanup();
  }

  private async upload(type: string): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const durationMs = Math.min(this.opts.maxMs, Date.now() - this.started);
    const blob = new Blob(this.chunks, { type });
    this.cleanup();
    if (blob.size === 0) return;
    const result = await uploadRecording(this.opts.ticket, { blob, durationMs }, this.opts.base);
    this.opts.onDone?.(result);
  }

  private cleanup(): void {
    this.finished = true;
    void this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.dest = undefined;
  }
}
