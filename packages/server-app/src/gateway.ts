import type { Device } from "@opentincan/db";
import {
  type AppToServer,
  type DeviceToServer,
  decodeAppToServer,
  decodeDeviceToServer,
  PROTOCOL_VERSION,
  toBase64Url,
} from "@opentincan/protocol";
import { verifyEd25519 } from "./deviceAuth.ts";
import { CloseCode, type Conn, HELLO_TIMEOUT_MS, type ServerEnv } from "./env.ts";
import { HouseholdHub, type Peer } from "./hub.ts";

/** What a transport (Node `ws`, Workers WebSocket) drives for each socket. */
export interface ConnectionHandler {
  message(raw: string): void;
  closed(): void;
}

type DevicePhase =
  | { kind: "hello" }
  | { kind: "unpaired"; code?: string }
  | { kind: "challenge"; device: Device; nonce: Uint8Array<ArrayBuffer> }
  | { kind: "ready"; hub: HouseholdHub; peer: Peer }
  | { kind: "closed" };

type AppPhase =
  | { kind: "hello" }
  | { kind: "ready"; hub: HouseholdHub; peer: Peer }
  | { kind: "closed" };

/**
 * Entry point for every socket: runs the handshake (hello, pairing, signed auth) and then hands
 * the connection to its household hub.
 */
export class Gateway {
  private readonly hubs = new Map<string, HouseholdHub>();
  /** Devices currently showing a pairing code, by code. */
  private readonly waitingToPair = new Map<string, Conn>();

  private readonly env: ServerEnv;

  constructor(env: ServerEnv) {
    this.env = env;
  }

  hub(householdId: string): HouseholdHub {
    const hub = this.hubs.get(householdId) ?? new HouseholdHub(householdId, this.env);
    this.hubs.set(householdId, hub);
    return hub;
  }

  /** Tells a device waiting on `code` that a guardian claimed it. */
  notifyPaired(code: string, device: Device): void {
    const conn = this.waitingToPair.get(code);
    if (!conn) return;
    this.waitingToPair.delete(code);
    conn.send({ t: "pair.done", deviceId: device.id, householdId: device.householdId });
  }

  openDevice(conn: Conn): ConnectionHandler {
    let phase: DevicePhase = { kind: "hello" };
    // Re-read after awaits: the socket may have closed meanwhile (TS keeps stale narrowing).
    const closed = () => (phase as DevicePhase).kind === "closed";
    let chain: Promise<void> = Promise.resolve();
    const cancelHello = this.env.setTimer(() => {
      if (phase.kind === "hello" || phase.kind === "challenge") fail(CloseCode.timeout, "timeout");
    }, HELLO_TIMEOUT_MS);

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
          if (msg.proto !== PROTOCOL_VERSION) {
            conn.send({
              t: "error",
              code: "unsupported_version",
              message: `server speaks protocol ${PROTOCOL_VERSION}`,
            });
            return fail(CloseCode.badHandshake, "unsupported protocol version");
          }
          if (!msg.deviceId) {
            phase = { kind: "unpaired" };
            return;
          }
          const device = await this.env.store.getDevice(msg.deviceId);
          if (!device) {
            conn.send({ t: "error", code: "unauthorized", message: "unknown device; re-pair" });
            return fail(CloseCode.unauthorized, "unknown device");
          }
          const nonce = crypto.getRandomValues(new Uint8Array(32));
          phase = { kind: "challenge", device, nonce };
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
          );
          if (closed()) return;
          phase.code = code;
          this.waitingToPair.set(code, conn);
          cancelHello(); // a device may show its code for as long as the code is valid
          conn.send({ t: "pair.code", code, expiresAt });
          return;
        }
        case "challenge": {
          if (msg.t !== "auth.proof") return fail(CloseCode.badHandshake, "expected auth.proof");
          const { device, nonce } = phase;
          if (!(await verifyEd25519(device.publicKey, msg.sig, nonce))) {
            conn.send({ t: "error", code: "unauthorized", message: "bad signature" });
            return fail(CloseCode.unauthorized, "bad signature");
          }
          cancelHello();
          await this.env.store.touchDevice(device.id, this.env.now());
          const hub = this.hub(device.householdId);
          const peer = await hub.connectDevice(device, conn);
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
          conn.send({ t: "error", code: "bad_message", message: decoded.detail });
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

  openApp(conn: Conn): ConnectionHandler {
    let phase: AppPhase = { kind: "hello" };
    const closed = () => (phase as AppPhase).kind === "closed";
    let chain: Promise<void> = Promise.resolve();
    const cancelHello = this.env.setTimer(() => {
      if (phase.kind === "hello") {
        phase = { kind: "closed" };
        conn.close(CloseCode.timeout, "timeout");
      }
    }, HELLO_TIMEOUT_MS);

    const handle = async (msg: AppToServer): Promise<void> => {
      if (phase.kind === "closed") return;
      if (phase.kind === "ready") return phase.hub.handleApp(phase.peer, msg);
      if (msg.t !== "app.hello") {
        phase = { kind: "closed" };
        cancelHello();
        return conn.close(CloseCode.badHandshake, "expected app.hello");
      }
      cancelHello();
      if (msg.proto !== PROTOCOL_VERSION) {
        conn.send({ t: "error", code: "unsupported_version", message: "please reload the app" });
        phase = { kind: "closed" };
        return conn.close(CloseCode.badHandshake, "unsupported protocol version");
      }
      const user = await this.env.store.userForToken(msg.token, this.env.now());
      if (!user) {
        conn.send({ t: "error", code: "unauthorized", message: "session expired" });
        phase = { kind: "closed" };
        return conn.close(CloseCode.unauthorized, "unauthorized");
      }
      const hub = this.hub(user.householdId);
      const peer = await hub.connectApp(user, conn);
      if (closed()) return hub.disconnect(peer);
      phase = { kind: "ready", hub, peer };
    };

    return {
      message: (raw) => {
        const decoded = decodeAppToServer(raw);
        if (!decoded.ok) {
          conn.send({ t: "error", code: "bad_message", message: decoded.detail });
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
