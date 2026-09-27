import { type DecodeResult, encode } from "@opentincan/protocol";

export type SocketStatus = "connecting" | "open" | "closed";

export interface SocketOptions<In, Out extends { t: string }> {
  url: string;
  decode(raw: string): DecodeResult<In>;
  /** Called on every (re)connect; send the handshake here. */
  onOpen(send: (msg: Out) => void): void;
  onMessage(msg: In): void;
  onStatus?(status: SocketStatus, detail?: { code: number; reason: string }): void;
  /** Return false to stop reconnecting after this close (e.g. unauthorized). */
  shouldReconnect?(code: number): boolean;
}

/** WebSocket that reconnects with capped exponential backoff and speaks the JSON protocol. */
export class ProtocolSocket<In, Out extends { t: string }> {
  private ws?: WebSocket;
  private attempt = 0;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly opts: SocketOptions<In, Out>;

  constructor(opts: SocketOptions<In, Out>) {
    this.opts = opts;
    this.connect();
  }

  send(msg: Out): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(encode(msg));
    return true;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    this.ws?.close(1000, "bye");
  }

  /** Drop the current connection and dial again immediately (e.g. after pairing). */
  reconnect(): void {
    this.attempt = 0;
    this.ws?.close(1000, "reconnect");
  }

  private connect(): void {
    this.opts.onStatus?.("connecting");
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.opts.onStatus?.("open");
      this.opts.onOpen((m) => this.send(m));
      // Application-level keepalive also exercises NAT mappings on flaky networks.
      this.pingTimer = setInterval(() => this.send({ t: "ping" } as Out), 25_000);
    };
    ws.onmessage = (e) => {
      const res = this.opts.decode(String(e.data));
      if (res.ok) this.opts.onMessage(res.msg);
      else console.warn("dropping bad server message", res.detail);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.opts.onStatus?.("closed", { code: e.code, reason: e.reason });
      if (this.stopped || this.opts.shouldReconnect?.(e.code) === false) return;
      const delay = Math.min(30_000, 500 * 2 ** this.attempt++) * (0.75 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }
}

/** ws:// or wss:// URL for a path on the page's own origin. */
export function socketUrl(path: string, origin: string = location.origin): string {
  return origin.replace(/^http/, "ws") + path;
}
