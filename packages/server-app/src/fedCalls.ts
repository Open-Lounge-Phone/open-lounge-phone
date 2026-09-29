// Calls between households that aren't the same hub: people connected across households on this
// server (host '') or across servers. The caller's hub opens a room whose far end is a proxy
// peer; the callee's server authorizes on its own terms and opens the matching room. Signaling
// flows between the two rooms: directly between hubs here, over the server-pair stream otherwise.
import { isRemoteContactId, LOCAL_HOST } from "@openloungephone/db";
import {
  type CallBody,
  CallResult,
  type FedSignal,
  type LoungeDialBody,
  type LoungeProgressBody,
  type Party,
  parseAddress,
} from "@openloungephone/federation";
import type { CallLinks, RingResult, ServerEnv } from "./env.ts";
import { FederationError, fedFetch, ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";

/** A call to ring here on behalf of someone elsewhere (see `HouseholdHub.remoteRing`). */
export interface RemoteRing {
  callId: string;
  /** The caller's server; '' = another household on this server. */
  host: string;
  /** Stable key for the caller, for busy checks: `fed:<host>:<account id>`. */
  key: string;
  label: string;
  target:
    | { kind: "person"; userId: string }
    | { kind: "phone"; deviceId: string; contactId: string }
    /** A Lounge phone here where the caller's server's account is a guest. */
    | { kind: "guest"; deviceId: string; guestId: string };
  /** Ring only here: a branch of a call another household here owns (no further fan-out). */
  noBranches?: boolean;
  /** The caller, for the call log: `handle@host`. */
  address?: string;
  /** For calls between households here: the caller's household. */
  peerHousehold?: string;
}

/** A guest (one of our accounts) dials from another server's Lounge phone; see `relayDial`. */
export interface RelayDial {
  /** The Lounge phone's server, and the call's id there. */
  host: string;
  callId: string;
  deviceId: string;
  deviceLabel: string;
  /** The guest's connection to the person they're calling. */
  connectionId: string;
}

/** Access to the per-server streams (in-process registry, or a Durable Object per host). */
export interface StreamPort {
  register(host: string, callId: string, householdId: string): Promise<void>;
  signal(host: string, msg: FedSignal): Promise<void>;
}

const deny: RingResult = { state: "ended", reason: "denied" };

/** The household where federated calls for an account ring: its first (personal) space. */
export async function primaryHousehold(env: ServerEnv, accountId: string) {
  return (await env.store.listMemberships(accountId))[0];
}

export class FedCalls implements CallLinks {
  private readonly env: ServerEnv;
  private readonly live: Coordinator;
  private readonly streams: StreamPort;

  constructor(env: ServerEnv, live: Coordinator, streams: StreamPort) {
    this.env = env;
    this.live = live;
    this.streams = streams;
  }

  /**
   * Someone at `host` (or in another household here) calls someone here. Everything is decided
   * here: an active connection, the phone's allow-list and quiet hours, availability, busy.
   */
  async receive(host: string, body: CallBody, peerHousehold?: string): Promise<RingResult> {
    const { store } = this.env;
    const from: Party = body.from;
    const key = `fed:${host}:${from.id}`;
    if (body.to.kind === "person") {
      const account = await store.accountByHandle(body.to.handle);
      if (!account || account.suspendedAt !== null) return deny;
      if (host === LOCAL_HOST && account.id === from.id) return deny;
      const conn = await store.connections.findPeer(account.id, host, from);
      if (conn?.state !== "active" || conn.peerAccount !== from.id) return deny;
      if (await store.connections.blocked(account.id, host, from)) return deny;
      const home = await primaryHousehold(this.env, account.id);
      if (!home) return { state: "ended", reason: "unreachable" };
      const who = conn.peerName || from.name;
      const label = body.viaPhone ? `${body.viaPhone.label} (${who})` : who;
      await this.register(host, body.callId, home.household.id);
      return this.live.ringRemote(home.household.id, {
        callId: body.callId,
        host,
        key,
        address: `${from.handle}@${host || ownHost(this.env)}`,
        label: label.slice(0, 24),
        target: { kind: "person", userId: home.user.id },
        ...(peerHousehold ? { peerHousehold } : {}),
      });
    }
    if (body.to.kind === "guest") {
      // The guest's own server rings its account at our Lounge phone; the hub checks that this
      // server is the one that vouched for the guest there.
      const lounge = await store.getDevice(body.to.deviceId);
      if (lounge?.kind !== "lounge" || host === LOCAL_HOST) return deny;
      await this.register(host, body.callId, lounge.householdId);
      return this.live.ringRemote(lounge.householdId, {
        callId: body.callId,
        host,
        // Not the guest's own key: someone here may be calling the guest right now, and this
        // ring is one leg of that very call.
        key: `fed:${host}:guest-ring:${body.callId}`,
        address: `${from.handle}@${host}`,
        label: (body.ringLabel ?? from.name).slice(0, 24),
        target: { kind: "guest", deviceId: lounge.id, guestId: from.id },
      });
    }
    const device = await store.getDevice(body.to.deviceId);
    if (!device) return deny;
    const entry = (await store.listRemoteContacts(device.id)).find(
      (r) => r.connection.peerHost === host && r.connection.peerAccount === from.id,
    );
    if (!entry) return deny;
    await this.register(host, body.callId, device.householdId);
    return this.live.ringRemote(device.householdId, {
      callId: body.callId,
      host,
      key,
      address: `${from.handle}@${host || ownHost(this.env)}`,
      label: entry.label,
      target: { kind: "phone", deviceId: device.id, contactId: entry.id },
      ...(peerHousehold ? { peerHousehold } : {}),
    });
  }

  /** Asks the far end to ring. `callerHousehold` routes a local callee's signals back. */
  async place(host: string, body: CallBody, callerHousehold: string): Promise<RingResult> {
    if (host === LOCAL_HOST) return this.receive(LOCAL_HOST, body, callerHousehold);
    try {
      const res = await fedFetch(this.env, host, "/calls", { json: body });
      const parsed = CallResult.safeParse(await res.json());
      return parsed.success ? parsed.data : { state: "ended", reason: "error" };
    } catch (e) {
      const reason = e instanceof FederationError && e.status === 429 ? "busy" : "unreachable";
      return { state: "ended", reason };
    }
  }

  ringLocal(householdId: string, req: RemoteRing): Promise<RingResult> {
    return this.live.ringRemote(householdId, req);
  }

  async register(host: string, callId: string, householdId: string): Promise<void> {
    if (host !== LOCAL_HOST) await this.streams.register(host, callId, householdId);
  }

  async signal(to: { host: string; householdId?: string }, msg: FedSignal): Promise<void> {
    if (to.host !== LOCAL_HOST) return this.streams.signal(to.host, msg);
    if (to.householdId) await this.live.remoteSignal(to.householdId, LOCAL_HOST, msg);
  }
}

export { isRemoteContactId };

/**
 * The Lounge phone's side: a guest pressed a key; their server places the call as them.
 */
export async function placeGuestDial(
  env: ServerEnv,
  host: string,
  body: LoungeDialBody,
): Promise<CallResult> {
  try {
    const res = await fedFetch(env, host, "/lounge/dial", { json: body });
    const parsed = CallResult.safeParse(await res.json());
    return parsed.success ? parsed.data : { state: "ended", reason: "error" };
  } catch {
    return { state: "ended", reason: "unreachable" };
  }
}

/** Tells a guest's server how their takeover of our Lounge phone is going. */
export async function sendGuestProgress(
  env: ServerEnv,
  host: string,
  body: LoungeProgressBody,
): Promise<void> {
  try {
    await fedFetch(env, host, "/lounge/progress", { json: body });
  } catch (e) {
    env.log("warn", "lounge: progress not delivered", { host, error: String(e) });
  }
}

/**
 * The guest's side: the Lounge phone's server relays a key press. Only while that server has a
 * live session for this account on that phone (we vouched for it), and only to someone the
 * account is connected with — the same rules as calling from their own app.
 */
export async function receiveGuestDial(
  env: ServerEnv,
  live: Coordinator,
  host: string,
  body: LoungeDialBody,
): Promise<CallResult> {
  const { store } = env;
  const denied = { state: "ended", reason: "denied" } as const;
  const account = await store.accountByHandle(body.for);
  if (!account) return denied;
  if ((await store.loungeAwayState(account.id, host, body.deviceId)) !== "active") return denied;
  const addr = parseAddress(body.to);
  if (!addr) return denied;
  const peerHost = addr.host === ownHost(env) ? LOCAL_HOST : addr.host;
  const conn = await store.connections.find(account.id, peerHost, addr.handle);
  if (conn?.state !== "active" || !conn.peerAccount) return denied;
  const home = await primaryHousehold(env, account.id);
  if (!home) return { state: "ended", reason: "unreachable" };
  return live.relayDial(home.household.id, {
    host,
    callId: body.callId,
    deviceId: body.deviceId,
    deviceLabel: body.deviceLabel,
    connectionId: conn.id,
  });
}
