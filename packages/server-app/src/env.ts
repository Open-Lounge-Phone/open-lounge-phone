import type { RoomState } from "@openloungephone/core";
import type { Store } from "@openloungephone/db";
import type {
  DeviceToServer,
  IceServer,
  ServerToApp,
  ServerToDevice,
} from "@openloungephone/protocol";

/** Opaque binary storage for voicemail audio (local disk, or R2 on Cloudflare). */
export interface BlobStore {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ data: ArrayBuffer; contentType: string } | undefined>;
  delete(key: string): Promise<void>;
}

/** Speech-to-text for voicemail (Workers AI Whisper, or an OpenAI-compatible endpoint). */
export interface Transcriber {
  transcribe(audio: ArrayBuffer, contentType: string): Promise<string>;
}

/** Everything the server needs from its host platform. Node and Workers each provide one. */
export interface ServerEnv {
  store: Store;
  blobs: BlobStore;
  /** Absent when no speech-to-text is configured; transcripts are then "unavailable". */
  transcriber?: Transcriber;
  /** Keeps background work alive after the response (Workers `waitUntil`). */
  defer(work: Promise<unknown>): void;
  /** Canonical public URL (e.g. behind a TLS proxy); passkeys bind to its host. */
  publicUrl?: string;
  now(): number;
  /** ICE servers handed to both peers of a call (STUN, and TURN with fresh credentials). */
  iceServers(): Promise<IceServer[]>;
  /** Schedules `fn` after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  log(level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>): void;
  /**
   * Hosts that can sleep (Durable Objects) provide this: the hub asks to be woken at `at` (or
   * cancels with null) and the host calls `HouseholdHub.wake()` then. Without it the hub uses
   * `setTimer`.
   */
  wakeAt?(at: number | null): void;
  /** Hosts that can be evicted persist live call rooms so they survive a restart. */
  saveRooms?(householdId: string, rooms: RoomSnapshot[]): void;
}

/** Everything needed to rebuild an authenticated connection's peer after the host slept. */
export interface PeerInfo {
  /** Unique per connection; rooms refer to peers by it. */
  session: string;
  householdId: string;
  kind: "device" | "user";
  id: string;
  label: string;
  guardian: boolean;
  hook?: "up" | "down";
  status?: Extract<DeviceToServer, { t: "status" }>;
  lastQuiet?: boolean;
}

/** Per-connection state a sleeping host keeps alongside the socket (≤16 KiB serialized). */
export type ConnMemo = { kind: "peer"; peer: PeerInfo } | { kind: "pairing"; code: string };

export interface RoomSnapshot {
  id: string;
  state: RoomState;
  /** Sessions of the caller and, once known, the callee. */
  caller: string;
  callee?: string;
}

/** One WebSocket, as seen by the server. */
export interface Conn {
  send(msg: ServerToDevice | ServerToApp): void;
  close(code: number, reason: string): void;
  /** Hosts that can sleep store this with the socket; see `Gateway.resume`. */
  remember?(memo: ConnMemo): void;
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
