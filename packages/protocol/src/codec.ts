import type { z } from "zod";
import { MAX_MESSAGE_BYTES } from "./common.ts";
import { AppToServer, DeviceToServer, ServerToApp, ServerToDevice } from "./messages.ts";

export type DecodeResult<T> =
  | { ok: true; msg: T }
  | { ok: false; error: "too_large" | "not_json" | "invalid"; detail: string };

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

function decodeWith<S extends z.ZodType>(schema: S, raw: string): DecodeResult<z.infer<S>> {
  if (exceedsLimit(raw)) {
    return { ok: false, error: "too_large", detail: `message exceeds ${MAX_MESSAGE_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: "not_json", detail: (e as Error).message };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "(root)";
    return { ok: false, error: "invalid", detail: `${where}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, msg: parsed.data };
}

export const decodeDeviceToServer = (raw: string) => decodeWith(DeviceToServer, raw);
export const decodeServerToDevice = (raw: string) => decodeWith(ServerToDevice, raw);
export const decodeAppToServer = (raw: string) => decodeWith(AppToServer, raw);
export const decodeServerToApp = (raw: string) => decodeWith(ServerToApp, raw);

/** Encode an outgoing message. Senders are trusted to build well-typed messages. */
export function encode<T extends { t: string }>(msg: T): string {
  return JSON.stringify(msg);
}
