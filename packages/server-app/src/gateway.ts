import type { Device } from "@openloungephone/db";
import type { FedSignal, RoomJoinResult } from "@openloungephone/federation";
import {
  type AppToServer,
  type DecodeResult,
  type DeviceToServer,
  decodeAppToServer,
  decodeDeviceToServer,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  type ServerToApp,
  type ServerToDevice,
  toBase64Url,
} from "@openloungephone/protocol";
import { verifyDeviceSignature } from "./deviceAuth.ts";
import {
  CloseCode,
  type ConferenceSnapshot,
  type Conn,
  type ConnMemo,
  HELLO_TIMEOUT_MS,
  type LoungeGuest,
  type RingResult,
  type RoomSnapshot,
  type ServerEnv,
} from "./env.ts";
import type { RelayDial, RemoteRing, RemoteRoomJoin } from "./fedCalls.ts";
import { HouseholdHub, type Peer } from "./hub.ts";
import { SERVER_INFO } from "./version.ts";

/** What a phone shows when its protocol is older than this server accepts. */
export const UPDATE_NEEDED = "UPDATE NEEDED";

/**
 * The answer to a message that didn't decode. One of an unknown type (a newer client's) is "not
 * supported", naming the type; the connection stays open either way.
 */
function decodeError(decoded: Extract<DecodeResult<unknown>, { ok: false }>): ServerToDevice {
  return {
    t: "error",
    code: "bad_message",
    message: decoded.detail.slice(0, 256),
    ...(decoded.error === "unsupported" ? { unsupported: decoded.type } : {}),
  };
}

/**
 * Whether a client's protocol version is one this server serves; if not, tells it why (a phone
 * that is too old also gets a `config` with `update`, which firmware shows on its display).
 */
export function protocolAccepted(
  conn: Pick<Conn, "send">,
  proto: number,
  device: boolean,
  accepts = { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
): boolean {
  const { min, max } = accepts;
  if (proto >= min && proto <= max) return true;
  const range = min === max ? `${max}` : `${min}–${max}`;
  const tooOld = proto < min;
  const server = { ...SERVER_INFO, protocol: { min, max } };
  if (tooOld && device) {
    conn.send({
      t: "config",
      buttons: [],
      quiet: false,
      update: { minProtocol: min, message: UPDATE_NEEDED },
      server,
    });
  }
  conn.send({
    t: "error",
    code: "unsupported_version",
    message: tooOld
      ? `Update needed: this server accepts protocol ${range}; this ${device ? "phone" : "app"} speaks ${proto}`
      : `This server is older: it accepts protocol ${range}; this ${device ? "phone" : "app"} speaks ${proto}`,
    server,
  });
  return false;
}

/** What a transport (Node `ws`, Workers WebSocket) drives for each socket. */
export interface ConnectionHandler {
  message(raw: string): void;
  closed(): void;
}

/**
 * What the HTTP API needs from the live side of the server. The in-process `Gateway` implements
 * it directly; on Cloudflare it is backed by Durable Object RPC.
 */
export interface Coordinator {
  isOnline(householdId: string, deviceId: string): Promise<boolean>;
  refreshDevice(householdId: string, deviceId: string): Promise<void>;
  notifyPaired(code: string, device: Device): Promise<void>;
  /** Sends a message to the household's connected guardians. */
  announce(householdId: string, msg: ServerToApp): Promise<void>;
  /** Disconnects a removed phone so it goes back to pairing. */
  forgetDevice(householdId: string, deviceId: string): Promise<void>;
  /** Sends a message to every open companion session of an account, in all its households. */
  notifyAccount(accountId: string, msg: ServerToApp): Promise<void>;
  /** Rings someone in a household for a caller elsewhere (see `HouseholdHub.remoteRing`). */
  ringRemote(householdId: string, req: RemoteRing): Promise<RingResult>;
  /** Signaling for a household's call with another household or server. */
  remoteSignal(householdId: string, host: string, msg: FedSignal): Promise<void>;
  /** A guest at another server's Lounge phone dials; this household places it as them. */
  relayDial(householdId: string, req: RelayDial): Promise<RingResult>;
  /** Another server vouches for its account at one of this household's Lounge phones. */
  guestClaim(
    householdId: string,
    deviceId: string,
    nonce: string,
    guest: LoungeGuest,
  ): Promise<GuestClaimResult>;
  guestLeave(householdId: string, deviceId: string, host: string, guestId: string): Promise<void>;
  /** Someone elsewhere asks to join one of the household's phone rooms. */
  roomJoin(householdId: string, req: RemoteRoomJoin): Promise<RoomJoinResult>;
  /** Who's in each of the household's live rooms (names by room id). */
  roomPeople(householdId: string): Promise<Record<string, string[]>>;
  /** A room was deleted: everyone in it is out. */
  closeRoom(householdId: string, roomId: string): Promise<void>;
}

export type GuestClaimResult =
  | { step: "press_key"; expiresAt: number }
  | { step: "failed"; reason: "expired" | "wrong_key" | "timeout" | "busy" | "not_found" };

type DevicePhase =
  | { kind: "hello" }
  | { kind: "unpaired"; code?: string }
  | {
      kind: "challenge";
      device: Device;
      nonce: Uint8Array<ArrayBuffer>;
      /** What it runs, from its hello (shown on the phone's page in the app). */
      runs: { fw: string; model: string };
    }
  /** A removed phone came back: once it proves it holds the removed key, it's told to wipe. */
  | {
      kind: "removed";
      id: string;
      key: { publicKey: string; keyAlg: Device["keyAlg"] };
      nonce: Uint8Array<ArrayBuffer>;
    }
  | { kind: "ready"; hub: HouseholdHub; peer: Peer }
  | { kind: "closed" };

type AppPhase =
  | { kind: "hello" }
  | { kind: "ready"; hub: HouseholdHub; peer: Peer }
  | { kind: "closed" };

export interface GatewayOptions {
  /** Only accept devices and users of this household (a Durable Object serves one). */
  household?: string;
  /** Only handle pairing; reject every paired device and app (the Cloudflare pairing object). */
  pairingOnly?: boolean;
}

export interface ResumeEntry {
  conn: Conn;
  memo: ConnMemo | undefined;
  /** True for companion-app sockets, false for devices. */
  app: boolean;
}

/**
 * Entry point for every socket: runs the handshake (hello, pairing, signed auth) and then hands
 * the connection to its household hub.
 */
export class Gateway implements Coordinator {
  private readonly hubs = new Map<string, HouseholdHub>();
  /** Devices currently showing a pairing code, by code. */
  private readonly waitingToPair = new Map<string, Conn>();
  private readonly env: ServerEnv;
  private readonly household?: string;
  private readonly pairingOnly: boolean;

  constructor(env: ServerEnv, options: GatewayOptions = {}) {
    this.env = env;
    if (options.household) this.household = options.household;
    this.pairingOnly = options.pairingOnly ?? false;
  }

  hub(householdId: string): HouseholdHub {
    const hub = this.hubs.get(householdId) ?? new HouseholdHub(householdId, this.env);
    this.hubs.set(householdId, hub);
    return hub;
  }

  private allowed(householdId: string): boolean {
    if (this.pairingOnly) return false;
    return this.household === undefined || this.household === householdId;
  }

  // --- Coordinator ------------------------------------------------------------

  async isOnline(householdId: string, deviceId: string): Promise<boolean> {
    return this.hubs.get(householdId)?.isOnline(deviceId) ?? false;
  }

  async refreshDevice(householdId: string, deviceId: string): Promise<void> {
    await this.hubs.get(householdId)?.refreshDevice(deviceId);
  }

  async announce(householdId: string, msg: ServerToApp): Promise<void> {
    await this.hubs.get(householdId)?.announce(msg);
  }

  async forgetDevice(householdId: string, deviceId: string): Promise<void> {
    await this.hubs.get(householdId)?.forgetDevice(deviceId);
  }

  async notifyAccount(accountId: string, msg: ServerToApp): Promise<void> {
    for (const m of await this.env.store.listMemberships(accountId)) {
      await this.hubs.get(m.household.id)?.sendToUser(m.user.id, msg);
    }
  }

  ringRemote(householdId: string, req: RemoteRing): Promise<RingResult> {
    if (!this.allowed(householdId)) return Promise.resolve({ state: "ended", reason: "error" });
    return this.hub(householdId).remoteRing(req);
  }

  async remoteSignal(householdId: string, host: string, msg: FedSignal): Promise<void> {
    await this.hubs.get(householdId)?.remoteSignal(host, msg);
  }

  relayDial(householdId: string, req: RelayDial): Promise<RingResult> {
    if (!this.allowed(householdId)) return Promise.resolve({ state: "ended", reason: "error" });
    return this.hub(householdId).relayDial(req);
  }

  async guestClaim(
    householdId: string,
    deviceId: string,
    nonce: string,
    guest: LoungeGuest,
  ): Promise<GuestClaimResult> {
    const hub = this.allowed(householdId) ? this.hubs.get(householdId) : undefined;
    return hub ? hub.guestClaim(deviceId, nonce, guest) : { step: "failed", reason: "not_found" };
  }

  async guestLeave(householdId: string, deviceId: string, host: string, guestId: string) {
    await this.hubs.get(householdId)?.guestLeave(deviceId, host, guestId);
  }

  roomJoin(householdId: string, req: RemoteRoomJoin): Promise<RoomJoinResult> {
    if (!this.allowed(householdId)) return Promise.resolve({ ok: false, reason: "error" });
    return this.hub(householdId).remoteRoomJoin(req);
  }

  async roomPeople(householdId: string): Promise<Record<string, string[]>> {
    return this.hubs.get(householdId)?.roomPeople() ?? {};
  }

  async closeRoom(householdId: string, roomId: string): Promise<void> {
    await this.hubs.get(householdId)?.closeRoom(roomId);
  }

  /** Tells a device waiting on `code` that a guardian claimed it. */
  async notifyPaired(code: string, device: Device): Promise<void> {
    const conn = this.waitingToPair.get(code);
    if (!conn) return;
    this.waitingToPair.delete(code);
    conn.send({ t: "pair.done", deviceId: device.id, householdId: device.householdId });
  }

  // --- sockets ------------------------------------------------------------------

  openDevice(conn: Conn): ConnectionHandler {
    return this.deviceHandler(conn, { kind: "hello" });
  }

  openApp(conn: Conn): ConnectionHandler {
    return this.appHandler(conn, { kind: "hello" });
  }

  /**
   * Re-attaches sockets after the host slept, from the memos they stored via `Conn.remember`.
   * Sockets without a usable memo were mid-handshake; they are closed so the client reconnects.
   * Returns one handler per entry, in order.
   */
  resume(
    entries: ResumeEntry[],
    rooms: (householdId: string) => RoomSnapshot[],
    conferences?: (householdId: string) => ConferenceSnapshot | undefined,
  ): ConnectionHandler[] {
    const handlers: ConnectionHandler[] = [];
    const restorable = new Map<string, { index: number; entry: ResumeEntry; memo: ConnMemo }[]>();
    entries.forEach((entry, index) => {
      const { conn, memo, app } = entry;
      if (memo?.kind === "peer" && this.allowed(memo.peer.householdId)) {
        const list = restorable.get(memo.peer.householdId) ?? [];
        list.push({ index, entry, memo });
        restorable.set(memo.peer.householdId, list);
      } else if (memo?.kind === "pairing" && !app) {
        this.waitingToPair.set(memo.code, conn);
        handlers[index] = this.deviceHandler(conn, { kind: "unpaired", code: memo.code });
      } else {
        conn.close(CloseCode.badHandshake, "please reconnect");
        handlers[index] = { message() {}, closed() {} };
      }
    });
    for (const [householdId, list] of restorable) {
      const hub = this.hub(householdId);
      const peers = hub.restore(
        list.map(({ entry, memo }) => ({
          info: (memo as Extract<ConnMemo, { kind: "peer" }>).peer,
          conn: entry.conn,
        })),
        rooms(householdId),
        conferences?.(householdId),
      );
      list.forEach(({ index, entry }, k) => {
        const peer = peers[k] as Peer;
        handlers[index] = entry.app
          ? this.appHandler(entry.conn, { kind: "ready", hub, peer })
          : this.deviceHandler(entry.conn, { kind: "ready", hub, peer });
      });
    }
    return handlers;
  }

  private deviceHandler(conn: Conn, initial: DevicePhase): ConnectionHandler {
    let phase: DevicePhase = initial;
    // Re-read after awaits: the socket may have closed meanwhile (TS keeps stale narrowing).
    const closed = () => (phase as DevicePhase).kind === "closed";
    let chain: Promise<void> = Promise.resolve();
    const cancelHello =
      initial.kind === "hello"
        ? this.env.setTimer(() => {
            if (phase.kind === "hello" || phase.kind === "challenge" || phase.kind === "removed") {
              fail(CloseCode.timeout, "timeout");
            }
          }, HELLO_TIMEOUT_MS)
        : () => {};

    const fail = (code: number, reason: string) => {
      const was = phase;
      phase = { kind: "closed" };
      cancelHello();
      if (was.kind === "unpaired" && was.code) this.waitingToPair.delete(was.code);
      conn.close(code, reason);
    };
    const reject = (msg: DeviceToServer | undefined, message: string) =>
      conn.send({
        t: "error",
        code: "bad_message",
        message,
        ...(msg?.id ? { ref: msg.id } : {}),
      });

    const handle = async (msg: DeviceToServer): Promise<void> => {
      switch (phase.kind) {
        case "closed":
          return;
        case "ready":
          return phase.hub.handleDevice(phase.peer, msg);
        case "hello": {
          if (msg.t !== "hello") return fail(CloseCode.badHandshake, "expected hello");
          if (!protocolAccepted(conn, msg.proto, true)) {
            this.env.log("info", "device refused: protocol version", {
              proto: msg.proto,
              fw: msg.fw,
              model: msg.model,
            });
            return fail(CloseCode.badHandshake, "unsupported protocol version");
          }
          if (!msg.deviceId) {
            phase = { kind: "unpaired" };
            return;
          }
          const device = await this.env.store.getDevice(msg.deviceId);
          const removed = device ? undefined : await this.env.store.removedDevice(msg.deviceId);
          if (removed) {
            const nonce = crypto.getRandomValues(new Uint8Array(32));
            phase = { kind: "removed", id: msg.deviceId, key: removed, nonce };
            conn.send({ t: "auth.challenge", nonce: toBase64Url(nonce) });
            return;
          }
          if (!device || !this.allowed(device.householdId)) {
            conn.send({ t: "error", code: "unauthorized", message: "unknown device; re-pair" });
            return fail(CloseCode.unauthorized, "unknown device");
          }
          const nonce = crypto.getRandomValues(new Uint8Array(32));
          phase = { kind: "challenge", device, nonce, runs: { fw: msg.fw, model: msg.model } };
          conn.send({ t: "auth.challenge", nonce: toBase64Url(nonce) });
          return;
        }
        case "unpaired": {
          if (msg.t === "ping") return conn.send({ t: "pong" });
          if (msg.t !== "pair.begin") return reject(msg, "pair first");
          if (phase.code) this.waitingToPair.delete(phase.code);
          const { code, expiresAt } = await this.env.store.createPairing(
            msg.publicKey,
            this.env.now(),
            msg.alg ?? "ed25519",
            msg.kind,
          );
          if (closed()) return;
          phase.code = code;
          this.waitingToPair.set(code, conn);
          cancelHello(); // a device may show its code for as long as the code is valid
          conn.remember?.({ kind: "pairing", code });
          conn.send({ t: "pair.code", code, expiresAt });
          return;
        }
        case "removed": {
          if (msg.t !== "auth.proof") return fail(CloseCode.badHandshake, "expected auth.proof");
          const { id, key, nonce } = phase;
          if (!(await verifyDeviceSignature(key.keyAlg, key.publicKey, msg.sig, nonce))) {
            conn.send({ t: "error", code: "unauthorized", message: "bad signature" });
            return fail(CloseCode.unauthorized, "bad signature");
          }
          conn.send({ t: "wipe", reason: "removed" });
          await this.env.store.forgetRemovedDevice(id);
          return fail(CloseCode.unauthorized, "removed");
        }
        case "challenge": {
          if (msg.t !== "auth.proof") return fail(CloseCode.badHandshake, "expected auth.proof");
          const { device, nonce } = phase;
          if (!(await verifyDeviceSignature(device.keyAlg, device.publicKey, msg.sig, nonce))) {
            conn.send({ t: "error", code: "unauthorized", message: "bad signature" });
            return fail(CloseCode.unauthorized, "bad signature");
          }
          cancelHello();
          await this.env.store.touchDevice(device.id, this.env.now(), phase.runs);
          const hub = this.hub(device.householdId);
          // What it runs now (whether its client can record, for instance).
          const peer = await hub.connectDevice({ ...device, ...phase.runs }, conn);
          if (closed()) {
            await hub.disconnect(peer);
            return;
          }
          phase = { kind: "ready", hub, peer };
          return;
        }
      }
    };

    return {
      message: (raw) => {
        const decoded = decodeDeviceToServer(raw);
        if (!decoded.ok) {
          conn.send(decodeError(decoded));
          return;
        }
        chain = chain
          .then(() => handle(decoded.msg))
          .catch((e) => {
            this.env.log("error", "device message failed", { error: String(e) });
            conn.send({ t: "error", code: "internal", message: "internal error" });
          });
      },
      closed: () => {
        chain = chain.then(async () => {
          const was = phase;
          phase = { kind: "closed" };
          cancelHello();
          if (was.kind === "unpaired" && was.code) this.waitingToPair.delete(was.code);
          if (was.kind === "ready") await was.hub.disconnect(was.peer);
        });
      },
    };
  }

  private appHandler(conn: Conn, initial: AppPhase): ConnectionHandler {
    let phase: AppPhase = initial;
    const closed = () => (phase as AppPhase).kind === "closed";
    let chain: Promise<void> = Promise.resolve();
    const cancelHello =
      initial.kind === "hello"
        ? this.env.setTimer(() => {
            if (phase.kind === "hello") {
              phase = { kind: "closed" };
              conn.close(CloseCode.timeout, "timeout");
            }
          }, HELLO_TIMEOUT_MS)
        : () => {};

    const refuse = (code: number, reason: string) => {
      phase = { kind: "closed" };
      cancelHello();
      conn.close(code, reason);
    };

    const handle = async (msg: AppToServer): Promise<void> => {
      if (phase.kind === "closed") return;
      if (phase.kind === "ready") return phase.hub.handleApp(phase.peer, msg);
      if (msg.t !== "app.hello") return refuse(CloseCode.badHandshake, "expected app.hello");
      if (!protocolAccepted(conn, msg.proto, false)) {
        return refuse(CloseCode.badHandshake, "unsupported protocol version");
      }
      // The household comes from the hello, else the object's own household (Cloudflare routes
      // by `?household=`), else the session's active one. It must be one of the account's.
      const found = await this.env.store.sessionForToken(msg.token, this.env.now());
      const session = found?.account.suspendedAt === null ? found : undefined;
      const target = msg.household ?? this.household;
      const user =
        session && target
          ? await this.env.store.membership(session.account.id, target)
          : session?.user;
      if (!user || !this.allowed(user.householdId)) {
        conn.send({ t: "error", code: "unauthorized", message: "session expired" });
        return refuse(CloseCode.unauthorized, "unauthorized");
      }
      cancelHello();
      const hub = this.hub(user.householdId);
      const peer = await hub.connectApp(user, conn);
      if (closed()) return hub.disconnect(peer);
      phase = { kind: "ready", hub, peer };
    };

    return {
      message: (raw) => {
        const decoded = decodeAppToServer(raw);
        if (!decoded.ok) {
          conn.send(decodeError(decoded));
          return;
        }
        chain = chain
          .then(() => handle(decoded.msg))
          .catch((e) => {
            this.env.log("error", "app message failed", { error: String(e) });
            conn.send({ t: "error", code: "internal", message: "internal error" });
          });
      },
      closed: () => {
        chain = chain.then(async () => {
          const was = phase;
          phase = { kind: "closed" };
          cancelHello();
          if (was.kind === "ready") await was.hub.disconnect(was.peer);
        });
      },
    };
  }
}
