// Calls between households that aren't the same hub: people connected across households on this
// server (host '') or across servers. The caller's hub opens a room whose far end is a proxy
// peer; the callee's server authorizes on its own terms and opens the matching room. Signaling
// flows between the two rooms: directly between hubs here, over the server-pair stream otherwise.
import { ADDON_NOT_LINKED_NOTE, ADDONS_OFF_NOTE, CANT_CALL_NOTE } from "@openloungephone/core";
import { deviceMode, isRemoteContactId, LOCAL_HOST } from "@openloungephone/db";
import {
  type CallBody,
  CallResult,
  type Feature,
  type FedSignal,
  type LineCallbackBody,
  type LineCallbackMissedBody,
  LineCallbackMissedResult,
  type LoungeDialBody,
  type LoungeProgressBody,
  type Party,
  parseAddress,
  type RoomJoinBody,
  RoomJoinResult,
} from "@openloungephone/federation";
import type { ServerToApp } from "@openloungephone/protocol";
import { addonAccess, addonCallerLimited } from "./addons.ts";
import type { CallLinks, RingResult, ServerEnv } from "./env.ts";
import { FederationError, fedFetch, ownHost, versionNote } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { admitLineCall } from "./lines.ts";
import { peerSupports, UNAVAILABLE } from "./peers.ts";

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
    | { kind: "guest"; deviceId: string; guestId: string }
    /**
     * A public line (a published ring group), already admitted by `admitLineCall`.
     * `callbackSince`: the caller answered the line's call back; their place in line.
     */
    | { kind: "line"; groupId: string; callbackSince?: number }
    /**
     * One of our add-ons, already authorized (`addonAccess`); its owner's account pays. `share`:
     * the call came in through one of its shares, held by the caller.
     */
    | {
        kind: "addon";
        addonId: string;
        accountId: string;
        share?: { id: string; label: string; grantId: string };
      };
  /** Ring only here: a branch of a call another household here owns (no further fan-out). */
  noBranches?: boolean;
  /** The caller, for the call log: `handle@host`. */
  address?: string;
  /** For calls between households here: the caller's household. */
  peerHousehold?: string;
  /** A kids' phone is calling (through its guardian's connection): never recorded. */
  fromKidsPhone?: boolean;
  /**
   * The caller is an add-on: its name and address (`handle+name@host`, or its share's), for the
   * label; `share`: the label of the share it calls within.
   */
  addon?: { name: string; address: string; share?: string };
  /** The caller's account on their server (for a public line's call back). */
  from?: { id: string; handle: string };
}

/** A public line calls one of our people back: ring them (see `HouseholdHub.callbackRing`). */
export interface CallbackRing {
  /** The call they waited under (their place in line). */
  id: string;
  /** The line's server; '' = this one. */
  lineHost: string;
  line: { handle: string; name: string; description?: string };
  userId: string;
  accountId: string;
  /** Their handle (as the line knows it). */
  handle: string;
}

/** A line's call back nobody took (see `HouseholdHub.lineCallbackMissed`). */
export interface CallbackMissed {
  id: string;
  /** The person's server; '' = this one. */
  host: string;
  accountId: string;
}

/** Someone elsewhere joins one of this household's phone rooms (see `remoteRoomJoin`). */
export interface RemoteRoomJoin {
  /** Their server; '' = another household on this server. */
  host: string;
  /** Their side's id for this participation (routes `room.signal`). */
  leg: string;
  from: Party;
  roomId: string;
  /** Another household here: theirs. */
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

/** Why a server that refuses recorded calls said no. */
export const REFUSES_RECORDING = "This server doesn't take recorded calls";

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
    // A server may refuse recorded calls for its people (another household here is the same
    // server, and its own spaces' rules already apply).
    if (body.recording && host !== LOCAL_HOST && this.env.refuseRecordedCalls) {
      return { state: "ended", reason: "denied", note: REFUSES_RECORDING };
    }
    // Add-ons: none of it while they're off here, a call from one only to a person (never a
    // phone, so never a kids' phone), and nothing that came through a kids' phone or a guest.
    if (body.addon !== undefined || body.to.kind === "addon") {
      const plain = !body.viaPhone && body.guestOf === undefined && body.ringLabel === undefined;
      const ok =
        this.env.addons && plain && (body.addon !== undefined) !== (body.to.kind === "addon");
      if (!this.env.addons) return { state: "ended", reason: "unavailable", note: ADDONS_OFF_NOTE };
      if (!ok || (body.addon !== undefined && body.to.kind !== "person")) {
        return { state: "ended", reason: "unavailable" };
      }
    }
    if (body.addonShare && body.addon === undefined)
      return { state: "ended", reason: "unavailable" };
    if (body.to.kind === "addon") {
      // Its owner at its own address; at a share's, only someone holding that share. Everything
      // else looks the same (core/refusals.ts), except to the handle's own account here.
      const unavailable = { state: "ended", reason: "unavailable", note: CANT_CALL_NOTE } as const;
      const addon = await store.addons.byAddress(body.to.handle, body.to.name);
      if (!addon) {
        const own =
          host === LOCAL_HOST && (await store.accountByHandle(body.to.handle))?.id === from.id;
        return own ? { ...unavailable, note: ADDON_NOT_LINKED_NOTE } : unavailable;
      }
      const who = { host, accountId: from.id, handle: from.handle };
      const access = await addonAccess(this.env, addon, who, body.to.share);
      if (!access) return unavailable;
      const limited = await addonCallerLimited(this.env, addon, who);
      if (limited) return { state: "ended", reason: "denied", note: limited };
      await this.register(host, body.callId, addon.householdId);
      return this.live.ringRemote(addon.householdId, {
        callId: body.callId,
        host,
        key,
        address: `${from.handle}@${host || ownHost(this.env)}`,
        label: from.name.slice(0, 24),
        target: {
          kind: "addon",
          addonId: addon.id,
          accountId: addon.accountId,
          ...(access.share ? { share: access.share } : {}),
        },
        ...(peerHousehold ? { peerHousehold } : {}),
      });
    }
    if (body.to.kind === "person") {
      const account = await store.accountByHandle(body.to.handle);
      if (!account || account.suspendedAt !== null) return deny;
      if (host === LOCAL_HOST && account.id === from.id) return deny;
      const conn = await store.connections.findPeer(account.id, host, from);
      const connected = conn?.state === "active" && conn.peerAccount === from.id;
      let share = body.addonShare;
      if (body.addon !== undefined) {
        // An add-on calls someone here only within a share they hold, and never once they
        // stopped its calls. Checked by their own server: here, by the grant itself; for
        // another server's add-on, by what that server told us they hold (it can't call them
        // as an add-on without having said so). Its owner is never on another server.
        const unavailable = { state: "ended", reason: "unavailable" } as const;
        if (!share) return unavailable;
        const mute = { host, ownerAccount: from.id, name: body.addon };
        if (await store.addons.muted(account.id, mute)) return unavailable;
        if (host === LOCAL_HOST) {
          if (!(await this.holdsShare(from, body.addon, share.id, account))) return unavailable;
        } else {
          const held = connected
            ? (await store.addons.received(conn.id)).find(
                (x) => x.addon === body.addon && x.share === share?.id,
              )
            : undefined;
          if (!held) return unavailable;
          share = { id: held.share, label: held.label };
        }
      }
      // An add-on here calling within a share someone here holds needs no connection between
      // them (they may share a space instead): the share's grant decided above.
      if (!connected && !(body.addon !== undefined && host === LOCAL_HOST)) return deny;
      if (await store.connections.blocked(account.id, host, from)) return deny;
      const home = await primaryHousehold(this.env, account.id);
      if (!home) return { state: "ended", reason: "unreachable" };
      const who = conn?.peerName || from.name;
      const label = body.addon ?? (body.viaPhone ? `${body.viaPhone.label} (${who})` : who);
      const fromHost = host || ownHost(this.env);
      await this.register(host, body.callId, home.household.id);
      return this.live.ringRemote(home.household.id, {
        callId: body.callId,
        host,
        // An add-on is busy on its own, not when its owner is.
        key: body.addon ? `${key}:addon:${body.addon}` : key,
        address: `${from.handle}@${fromHost}`,
        label: label.slice(0, 24),
        target: { kind: "person", userId: home.user.id },
        ...(peerHousehold ? { peerHousehold } : {}),
        ...(body.viaPhone ? { fromKidsPhone: true } : {}),
        ...(body.addon
          ? {
              addon: {
                name: body.addon,
                address: `${from.handle}+${body.addon}${share ? `+${share.id}` : ""}@${fromHost}`,
                ...(share ? { share: share.label } : {}),
              },
            }
          : {}),
      });
    }
    if (body.to.kind === "line") {
      // A public line: no connection needed, the line's own rules instead. Every refusal looks
      // like an unavailable line (unknown, off, blocked, not allowed, over a limit, kids' phone).
      const unavailable = { state: "ended", reason: "unavailable" } as const;
      const line = await store.lines.byHandle(body.to.handle);
      if (!line?.enabled) return unavailable;
      const address = `${from.handle}@${host || ownHost(this.env)}`;
      // Calling back in after the line's call back: their place in line (once).
      let callbackSince: number | undefined;
      if (body.to.callback) {
        const row = await store.lines.callback(body.to.callback);
        const theirs =
          row?.groupId === line.groupId && row.host === host && row.accountId === from.id;
        if (!row || !theirs || !(await store.lines.takeCallback(row.id))) return unavailable;
        callbackSince = row.since;
      }
      const admitted = await admitLineCall(
        this.env,
        line,
        {
          address,
          host,
          accountId: from.id,
          name: from.name,
          kidsPhone: !!body.viaPhone,
        },
        { counted: callbackSince === undefined },
      );
      if (!admitted) return unavailable;
      await this.register(host, body.callId, line.householdId);
      return this.live.ringRemote(line.householdId, {
        callId: body.callId,
        host,
        key,
        address,
        label: from.name.slice(0, 24),
        target: {
          kind: "line",
          groupId: line.groupId,
          ...(callbackSince !== undefined ? { callbackSince } : {}),
        },
        from: { id: from.id, handle: from.handle },
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
    if (!entry) {
      // A kids' phone's call activity: someone not on its list tried to call it.
      if (deviceMode(device) === "kids") {
        await store.logCall({
          householdId: device.householdId,
          accountId: null,
          deviceId: device.id,
          peer: `${from.handle}@${host || ownHost(this.env)}`,
          peerLabel: from.name.slice(0, 64),
          direction: "in",
          startedAt: this.env.now(),
          answered: false,
          durationMs: 0,
          endReason: "denied",
          refused: "not_allowed",
        });
      }
      return deny;
    }
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

  /**
   * Asks the far end to ring. `callerHousehold` routes a local callee's signals back. Uses an
   * optional feature only with a server that advertises it: a recorded call is never placed with
   * one that can't announce it, and a guest's Lounge phone needs `lounge-guests`.
   */
  async place(host: string, body: CallBody, callerHousehold: string): Promise<RingResult> {
    if (host === LOCAL_HOST) return this.receive(LOCAL_HOST, body, callerHousehold);
    const needs: Feature[] = [
      ...(body.recording ? (["recording-flag"] as const) : []),
      ...(body.to.kind === "guest" ? (["lounge-guests"] as const) : []),
      ...(body.to.kind === "line" ? (["public-lines"] as const) : []),
      ...(body.to.kind === "line" && body.to.callback ? (["line-callback"] as const) : []),
      ...(body.to.kind === "addon" || body.addon ? (["addons"] as const) : []),
      ...((body.to.kind === "addon" && body.to.share) || body.addonShare
        ? (["addon-shares"] as const)
        : []),
    ];
    for (const feature of needs) {
      if (!(await peerSupports(this.env, host, feature))) {
        this.env.log("info", "federation: call not placed (feature)", { host, feature });
        return { state: "ended", reason: "denied", note: UNAVAILABLE[feature] };
      }
    }
    try {
      const res = await fedFetch(this.env, host, "/calls", { json: body });
      const parsed = CallResult.safeParse(await res.json());
      return parsed.success ? parsed.data : { state: "ended", reason: "error" };
    } catch (e) {
      const reason = e instanceof FederationError && e.status === 429 ? "busy" : "unreachable";
      const note = versionNote(e);
      return { state: "ended", reason, ...(note ? { note } : {}) };
    }
  }

  /** Whether `account` here holds a share of `from`'s add-on `name` (both on this server). */
  private async holdsShare(
    from: Party,
    name: string,
    shareId: string,
    account: { id: string; handle: string },
  ): Promise<boolean> {
    const addon = await this.env.store.addons.byAddress(from.handle, name);
    if (addon?.accountId !== from.id) return false;
    const who = { host: LOCAL_HOST, accountId: account.id, handle: account.handle };
    return !!(await addonAccess(this.env, addon, who, shareId));
  }

  refreshDevice(householdId: string, deviceId: string): Promise<void> {
    return this.live.refreshDevice(householdId, deviceId);
  }

  notifyAccount(accountId: string, msg: ServerToApp): Promise<void> {
    return this.live.notifyAccount(accountId, msg);
  }

  ringLocal(householdId: string, req: RemoteRing): Promise<RingResult> {
    return this.live.ringRemote(householdId, req);
  }

  /**
   * Someone at `host` (or in another household here) wants into one of our phone rooms. The
   * room's hub decides (see `HouseholdHub.remoteRoomJoin`).
   */
  async receiveRoomJoin(
    host: string,
    body: RoomJoinBody,
    peerHousehold?: string,
  ): Promise<RoomJoinResult> {
    const room = await this.env.store.rooms.byHandle(body.room);
    if (room?.kind !== "phone") return { ok: false, reason: "denied" };
    await this.register(host, body.leg, room.householdId);
    return this.live.roomJoin(room.householdId, {
      host,
      leg: body.leg,
      from: body.from,
      roomId: room.id,
      ...(peerHousehold ? { peerHousehold } : {}),
    });
  }

  async roomJoin(
    host: string,
    body: RoomJoinBody,
    callerHousehold: string,
  ): Promise<RoomJoinResult> {
    if (host === LOCAL_HOST) return this.receiveRoomJoin(LOCAL_HOST, body, callerHousehold);
    if (!(await peerSupports(this.env, host, "rooms"))) {
      return { ok: false, reason: "unreachable", note: UNAVAILABLE.rooms };
    }
    try {
      const res = await fedFetch(this.env, host, "/rooms/join", { json: body });
      const parsed = RoomJoinResult.safeParse(await res.json());
      return parsed.success ? parsed.data : { ok: false, reason: "error" };
    } catch (e) {
      const status = e instanceof FederationError ? e.status : 0;
      const note =
        e instanceof FederationError && e.code === "not_supported"
          ? UNAVAILABLE.rooms
          : versionNote(e);
      return {
        ok: false,
        reason: status === 429 ? "busy" : "unreachable",
        ...(note ? { note } : {}),
      };
    }
  }

  // --- call me back (feature `line-callback`) ----------------------------------------------

  /** A line here calls someone back: their hub here, or their server. */
  async callbackDue(host: string, body: LineCallbackBody): Promise<void> {
    if (host === LOCAL_HOST) return this.receiveCallback(LOCAL_HOST, body);
    if (!(await peerSupports(this.env, host, "line-callback"))) return;
    try {
      await fedFetch(this.env, host, "/lines/callback", { json: body });
    } catch (e) {
      this.env.log("warn", "line call back not delivered", { host, error: String(e) });
    }
  }

  /**
   * A line (at `host`, '' = here) calls one of our people back. Only if they asked that very
   * line under this call id, and not too long ago (default deny for everything else).
   */
  async receiveCallback(host: string, body: LineCallbackBody): Promise<void> {
    const grant = await this.env.store.lines.grant(body.id, host, body.to, this.env.now());
    if (!grant || grant.lineHandle !== body.line.handle.toLowerCase()) return;
    await this.live.callbackRing(grant.householdId, {
      id: body.id,
      lineHost: host,
      line: body.line,
      userId: grant.userId,
      accountId: grant.accountId,
      handle: body.to,
    });
  }

  async callbackMissed(
    host: string,
    body: LineCallbackMissedBody,
  ): Promise<LineCallbackMissedResult> {
    if (host === LOCAL_HOST) return this.receiveCallbackMissed(LOCAL_HOST, body);
    try {
      const res = await fedFetch(this.env, host, "/lines/callback/missed", { json: body });
      const parsed = LineCallbackMissedResult.safeParse(await res.json());
      return parsed.success ? parsed.data : { retry: false };
    } catch (e) {
      this.env.log("warn", "missed call back not delivered", { host, error: String(e) });
      return { retry: false };
    }
  }

  async receiveCallbackMissed(
    host: string,
    body: LineCallbackMissedBody,
  ): Promise<LineCallbackMissedResult> {
    const line = await this.env.store.lines.byHandle(body.line);
    if (!line) return { retry: false };
    return this.live.lineCallbackMissed(line.householdId, {
      id: body.id,
      host,
      accountId: body.from.id,
    });
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
  } catch (e) {
    const note = versionNote(e);
    return { state: "ended", reason: "unreachable", ...(note ? { note } : {}) };
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
