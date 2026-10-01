import type { z } from "zod";
import { MAX_MESSAGE_BYTES } from "./common.ts";
import { AppToServer, DeviceToServer, ServerToApp, ServerToDevice } from "./messages.ts";

export type DecodeResult<T> =
  | { ok: true; msg: T }
  | { ok: false; error: "too_large" | "not_json" | "invalid"; detail: string }
  /** A well-formed message of a type this side doesn't know (from a newer peer). */
  | { ok: false; error: "unsupported"; detail: string; type: string };

/** The `t` values a union of messages accepts. */
function typesOf(union: z.ZodType): ReadonlySet<string> {
  const options = (union as unknown as { options: { shape: { t: { value: string } } }[] }).options;
  return new Set(options.map((o) => o.shape.t.value));
}

function exceedsLimit(s: string): boolean {
  // A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so short strings skip the count.
  if (s.length * 3 <= MAX_MESSAGE_BYTES) return false;
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Surrogate pairs are 4 bytes total, i.e. 2 per code unit.
    bytes += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c < 0xe000) ? 2 : 3;
  }
  return bytes > MAX_MESSAGE_BYTES;
}

function decodeWith<S extends z.ZodType>(
  schema: S,
  types: ReadonlySet<string>,
  raw: string,
): DecodeResult<z.infer<S>> {
  if (exceedsLimit(raw)) {
    return { ok: false, error: "too_large", detail: `message exceeds ${MAX_MESSAGE_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "not_json", detail: (e as Error).message };
  }
  const t = (json as { t?: unknown } | null)?.t;
  if (typeof t === "string" && t.length <= 64 && !types.has(t)) {
    return { ok: false, error: "unsupported", detail: `not supported: ${t}`, type: t };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return { ok: false, error: "invalid", detail: `${where}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, msg: parsed.data };
}

const DEVICE_TO_SERVER = typesOf(DeviceToServer);
const SERVER_TO_DEVICE = typesOf(ServerToDevice);
const APP_TO_SERVER = typesOf(AppToServer);
const SERVER_TO_APP = typesOf(ServerToApp);

// Receivers are tolerant: unknown fields are dropped (zod objects strip them), and a message of
// an unknown type decodes to `unsupported` so the receiver can say so and carry on.
export const decodeDeviceToServer = (raw: string) =>
  decodeWith(DeviceToServer, DEVICE_TO_SERVER, raw);
export const decodeServerToDevice = (raw: string) =>
  decodeWith(ServerToDevice, SERVER_TO_DEVICE, raw);
export const decodeAppToServer = (raw: string) => decodeWith(AppToServer, APP_TO_SERVER, raw);
export const decodeServerToApp = (raw: string) => decodeWith(ServerToApp, SERVER_TO_APP, raw);

/** Encode an outgoing message. Senders are trusted to build well-typed messages. */
export function encode<T extends { t: string }>(msg: T): string {
  return JSON.stringify(msg);
}
