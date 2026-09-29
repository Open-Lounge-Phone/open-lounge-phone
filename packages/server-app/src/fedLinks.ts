// In-process server-pair streams (self-host and tests): one `ServerLink` per other server, with
// timers for the idle close. Cloudflare runs the same `ServerLink` in a Durable Object per host.
import { type FedSignal, HOST_RE } from "@openloungephone/federation";
import type { ServerEnv } from "./env.ts";
import type { StreamPort } from "./fedCalls.ts";
import { type LinkSocket, ServerLink } from "./fedStream.ts";
import type { Coordinator } from "./gateway.ts";

export type Dialer = (url: string, link: ServerLink) => Promise<LinkSocket>;

export class LinkRegistry implements StreamPort {
  private readonly links = new Map<string, ServerLink>();
  private readonly routes = new Map<string, string>();
  private readonly timers = new Map<string, () => void>();
  private readonly env: ServerEnv;
  private readonly live: Coordinator;
  private readonly dialer: Dialer;

  constructor(env: ServerEnv, live: Coordinator, dialer: Dialer) {
    this.env = env;
    this.live = live;
    this.dialer = dialer;
  }

  link(host: string): ServerLink {
    let link = this.links.get(host);
    if (link) return link;
    const key = (id: string) => `${host} ${id}`;
    link = new ServerLink(this.env, host, {
      dial: this.dialer,
      deliver: (householdId, msg) => this.live.remoteSignal(householdId, host, msg),
      routes: {
        get: async (id) => this.routes.get(key(id)),
        set: async (id, hh) => void this.routes.set(key(id), hh),
        delete: async (id) => void this.routes.delete(key(id)),
      },
      wakeAt: (at) => {
        this.timers.get(host)?.();
        this.timers.delete(host);
        if (at === null) return;
        const l = link as ServerLink;
        this.timers.set(
          host,
          this.env.setTimer(() => l.idle(), Math.max(0, at - this.env.now())),
        );
      },
    });
    this.links.set(host, link);
    return link;
  }

  register(host: string, callId: string, householdId: string): Promise<void> {
    return this.link(host).register(callId, householdId);
  }

  signal(host: string, msg: FedSignal): Promise<void> {
    return this.link(host).send(msg);
  }

  /** An inbound stream (`/fed/v1/stream?from=<host>`); undefined for a malformed host. */
  accept(from: string, socket: LinkSocket): ServerLink | undefined {
    if (!HOST_RE.test(from)) return undefined;
    const link = this.link(from);
    link.accept(socket);
    return link;
  }

  close(): void {
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    for (const link of this.links.values()) link.shutdown();
  }
}
