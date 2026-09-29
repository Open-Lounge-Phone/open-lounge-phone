// The server-pair stream: one WebSocket between two servers that carries call signaling
// (`call.state`, `rtc.sdp`, `rtc.ice`) for every federated call between them.
//
// - Opened on demand, by whichever side needs it first (`GET /fed/v1/stream?from=<host>`).
// - Authenticated in-band: the dialer's first message is a signed `hello`; the acceptor answers
//   with a signed `hello.ok` echoing the dialer's nonce (fresh, mutual, transport-agnostic).
// - The dialer closes it after STREAM_IDLE_MS with no call and no signaling, so neither side
//   keeps a connection (or, on Cloudflare, a non-hibernating Durable Object) open while idle.
//   The accepting side never closes it; on Cloudflare it hibernates.
// - Messages are routed by `callId` to the household that owns the call on this server.
import {
  baseUrlFor,
  FEDERATION_PATH,
  type FedSignal,
  MAX_SKEW_S,
  randomNonce,
  StreamHello,
  StreamSignal,
  signBytes,
  streamStatement,
  verifyBytes,
} from "@openloungephone/federation";
import type { ServerEnv } from "./env.ts";
import { ownHost, resolveServerKey, serverKey } from "./federation.ts";

/** Close an idle dialed stream this long after the last call or signal. */
export const STREAM_IDLE_MS = 60_000;
/** While calls are up, look again this often (a lost hangup must not pin the stream open). */
export const STREAM_BUSY_CHECK_MS = 10 * 60_000;
/** A call with no signaling for this long no longer counts as active. */
export const STREAM_CALL_STALE_MS = 6 * 60 * 60_000;
export const STREAM_PATH = `${FEDERATION_PATH}/stream`;

export interface LinkSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface SocketState {
  role: "dialer" | "acceptor";
  authed: boolean;
  /** The dialer's hello nonce (the acceptor must echo it). */
  nonce?: string;
}

export interface LinkPlatform {
  /** Opens a WebSocket; the platform feeds its events to `link.receive` / `link.closed`. */
  dial(url: string, link: ServerLink): Promise<LinkSocket>;
  /** Hands an inbound signal to the household that owns the call. */
  deliver(householdId: string, msg: FedSignal): Promise<void>;
  /** Call → household routes; a Durable Object keeps them in storage. */
  routes: {
    get(callId: string): Promise<string | undefined>;
    set(callId: string, householdId: string): Promise<void>;
    delete(callId: string): Promise<void>;
  };
  /** Wake `link.idle()` at `at` (an alarm on Durable Objects); null cancels. */
  wakeAt(at: number | null): void;
  /** Hosts that hibernate keep each socket's state with it (see `adopt`). */
  remember?(socket: LinkSocket, state: SocketState): void;
}

/** The stream with one other server. */
export class ServerLink {
  readonly host: string;
  private readonly env: ServerEnv;
  private readonly platform: LinkPlatform;
  private readonly sockets = new Map<LinkSocket, SocketState>();
  private opening?: Promise<LinkSocket | undefined>;
  /** Signals waiting for a dialed socket to finish its handshake. */
  private outbox: string[] = [];
  /** Calls with this server, by id → last signaling time. */
  private readonly calls = new Map<string, number>();
  private lastActivity = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private rx: Promise<unknown> = Promise.resolve();

  constructor(env: ServerEnv, host: string, platform: LinkPlatform) {
    this.env = env;
    this.host = host;
    this.platform = platform;
  }

  /** Re-attaches a socket after the host slept (Durable Object hibernation). */
  adopt(socket: LinkSocket, state: SocketState): void {
    this.sockets.set(socket, state);
  }

  /** Whether a socket is open (authenticated or not). */
  get open(): boolean {
    return this.sockets.size > 0;
  }

  /** Calls currently counted as active (for tests and the idle rule). */
  activeCalls(): string[] {
    return [...this.calls.keys()];
  }

  /** Routes this call's signals to `householdId` here, before any can arrive. */
  async register(callId: string, householdId: string): Promise<void> {
    await this.platform.routes.set(callId, householdId);
    this.touch(callId);
  }

  /** Sends one signal, in order, opening the stream if needed. */
  send(msg: FedSignal): Promise<void> {
    const next = this.chain.then(() => this.sendNow(msg));
    this.chain = next.catch((e) =>
      this.env.log("warn", "stream: send failed", { host: this.host, error: String(e) }),
    );
    return next;
  }

  private async sendNow(msg: FedSignal): Promise<void> {
    this.touch(msg.callId);
    if (endsRoute(msg)) await this.forget(msg.callId);
    const text = JSON.stringify({ t: "signal", msg });
    const ready = this.readySocket();
    if (ready) ready.send(text);
    else {
      this.outbox.push(text);
      const handshaking = [...this.sockets.values()].some((s) => s.role === "dialer");
      if (!handshaking) await this.dial();
    }
    this.scheduleIdle();
  }

  private readySocket(): LinkSocket | undefined {
    let found: LinkSocket | undefined;
    for (const [s, st] of this.sockets) if (st.authed) found = s;
    return found;
  }

  private dial(): Promise<LinkSocket | undefined> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const key = await serverKey(this.env);
      if (!key) throw new Error("federation is not configured");
      const me = ownHost(this.env);
      const url = `${baseUrlFor(this.host).replace(/^http/, "ws")}${STREAM_PATH}?from=${encodeURIComponent(me)}`;
      let socket: LinkSocket;
      try {
        socket = await this.platform.dial(url, this);
      } catch (e) {
        this.outbox = [];
        throw e;
      }
      const nonce = randomNonce();
      const created = Math.floor(this.env.now() / 1000);
      const state: SocketState = { role: "dialer", authed: false, nonce };
      this.sockets.set(socket, state);
      this.platform.remember?.(socket, state);
      socket.send(
        JSON.stringify({
          t: "hello",
          from: me,
          to: this.host,
          created,
          nonce,
          sig: await signBytes(key, streamStatement(me, this.host, created, nonce)),
        } satisfies StreamHello),
      );
      return socket;
    })().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  /** An inbound socket from this server (acceptor side). */
  accept(socket: LinkSocket): void {
    const state: SocketState = { role: "acceptor", authed: false };
    this.sockets.set(socket, state);
    this.platform.remember?.(socket, state);
  }

  /** A text frame arrived on one of this link's sockets. Handled strictly in order. */
  receive(socket: LinkSocket, text: string): Promise<void> {
    const next = this.rx.then(() => this.receiveNow(socket, text));
    this.rx = next.catch((e) =>
      this.env.log("warn", "stream: receive failed", { host: this.host, error: String(e) }),
    );
    return next;
  }

  private async receiveNow(socket: LinkSocket, text: string): Promise<void> {
    const state = this.sockets.get(socket);
    if (!state) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.drop(socket, "not JSON");
    }
    if (!state.authed) return this.handshake(socket, state, json);
    const parsed = StreamSignal.safeParse(json);
    if (!parsed.success) {
      this.env.log("warn", "stream: bad message", { host: this.host });
      return;
    }
    const msg = parsed.data.msg;
    const householdId = await this.platform.routes.get(msg.callId);
    if (!householdId) return; // not a call of ours (or long over)
    this.touch(msg.callId);
    if (endsRoute(msg)) await this.forget(msg.callId);
    this.scheduleIdle();
    await this.platform.deliver(householdId, msg);
  }

  private async handshake(socket: LinkSocket, state: SocketState, json: unknown): Promise<void> {
    const hello = StreamHello.safeParse(json);
    const me = ownHost(this.env);
    const key = await serverKey(this.env);
    if (!hello.success || !key) return this.drop(socket, "expected hello");
    const h = hello.data;
    const now = this.env.now();
    const fresh = Math.abs(now / 1000 - h.created) <= MAX_SKEW_S;
    if (h.from !== this.host || h.to !== me || !fresh) return this.drop(socket, "bad hello");
    const statement = streamStatement(h.from, h.to, h.created, h.nonce);
    const pinned = await resolveServerKey(this.env, this.host, false);
    let good = !!pinned && (await verifyBytes(pinned, statement, h.sig));
    if (!good) {
      const again = await resolveServerKey(this.env, this.host, true);
      good = !!again && (await verifyBytes(again, statement, h.sig));
    }
    if (!good) return this.drop(socket, "bad signature");
    if (state.role === "acceptor") {
      if (h.t !== "hello") return this.drop(socket, "expected hello");
      const nonceKey = `stream ${h.from} ${h.nonce}`;
      if (!(await this.env.store.connections.useNonce(nonceKey, now + 11 * 60_000, now))) {
        return this.drop(socket, "replayed hello");
      }
      const created = Math.floor(now / 1000);
      socket.send(
        JSON.stringify({
          t: "hello.ok",
          from: me,
          to: this.host,
          created,
          nonce: h.nonce,
          sig: await signBytes(key, streamStatement(me, this.host, created, h.nonce)),
        } satisfies StreamHello),
      );
    } else if (h.t !== "hello.ok" || h.nonce !== state.nonce) {
      return this.drop(socket, "bad hello.ok");
    }
    state.authed = true;
    this.platform.remember?.(socket, state);
    if (state.role === "dialer") {
      for (const text of this.outbox.splice(0)) socket.send(text);
    }
  }

  private drop(socket: LinkSocket, reason: string): void {
    this.env.log("warn", "stream: closing", { host: this.host, reason });
    this.sockets.delete(socket);
    socket.close(4401, reason);
  }

  /** The platform saw a socket close. */
  closed(socket: LinkSocket): void {
    this.sockets.delete(socket);
  }

  private touch(callId: string): void {
    const now = this.env.now();
    this.lastActivity = now;
    this.calls.set(callId, now);
  }

  private async forget(callId: string): Promise<void> {
    this.calls.delete(callId);
    await this.platform.routes.delete(callId);
  }

  /** Arms the one wake-up that closes a dialed socket once idle. */
  private scheduleIdle(): void {
    const dialed = [...this.sockets.values()].some((s) => s.role === "dialer");
    if (!dialed) {
      this.platform.wakeAt(null);
      return;
    }
    const now = this.env.now();
    this.platform.wakeAt(
      this.calls.size > 0 ? now + STREAM_BUSY_CHECK_MS : this.lastActivity + STREAM_IDLE_MS,
    );
  }

  /** Closes every socket (server shutdown). */
  shutdown(): void {
    for (const socket of [...this.sockets.keys()]) socket.close(1001, "shutting down");
    this.sockets.clear();
  }

  /**
   * Called at the wake-up time: closes the sockets this side dialed if there has been no call and
   * no signaling for STREAM_IDLE_MS. Returns whether anything is still open.
   */
  idle(): boolean {
    const now = this.env.now();
    for (const [id, at] of this.calls) {
      if (now - at >= STREAM_CALL_STALE_MS) this.calls.delete(id);
    }
    if (this.calls.size === 0 && now - this.lastActivity >= STREAM_IDLE_MS) {
      for (const [socket, state] of [...this.sockets]) {
        if (state.role !== "dialer") continue;
        this.sockets.delete(socket);
        socket.close(1000, "idle");
        this.env.log("info", "stream: closed after idle", { host: this.host });
      }
    }
    this.scheduleIdle();
    return this.open;
  }
}

/**
 * Whether a signal is the last on its route: a call that ended (not one merged into a room,
 * which goes on as a room leg under the same id), or a room leg that ended or was left.
 */
function endsRoute(msg: FedSignal): boolean {
  if (msg.t === "call.state") return msg.state === "ended" && !msg.merged;
  if (msg.t === "room.signal") return msg.msg.t === "room.ended" || msg.msg.t === "room.leave";
  return false;
}
