import type { Store } from "@opentincan/db";
import type { IceServer, ServerToApp, ServerToDevice } from "@opentincan/protocol";

/** Everything the server needs from its host platform. Node and Workers each provide one. */
export interface ServerEnv {
  store: Store;
  now(): number;
  /** ICE servers handed to both peers of a call (STUN, and TURN with fresh credentials). */
  iceServers(): Promise<IceServer[]>;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
}

/** One WebSocket, as seen by the server. */
export interface Conn {
  send(msg: ServerToDevice | ServerToApp): void;
  close(code: number, reason: string): void;
}

/** WebSocket close codes used by the server (4000-4999 is the application range). */
export const CloseCode = {
  replaced: 4000,
  badHandshake: 4400,
  unauthorized: 4401,
  timeout: 4408,
} as const;

export const HELLO_TIMEOUT_MS = 10_000;
export const RING_TIMEOUT_MS = 30_000;
export const CONNECT_TIMEOUT_MS = 20_000;
export const CONFIG_TICK_MS = 60_000;
