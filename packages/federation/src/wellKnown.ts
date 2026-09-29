import { z } from "zod";
import {
  keyRotationStatement,
  MAX_ROTATION_OVERLAP_S,
  type ServerKey,
  signBytes,
  verifyBytes,
} from "./keys.ts";

export const WELL_KNOWN_PATH = "/.well-known/openloungephone";
export const FEDERATION_PATH = "/fed/v1";
export const FEDERATION_VERSION = 1;

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A key rotation in its overlap window: the old key hands over to `server_key` (spec §3.2). */
export const KeyRotation = z.object({
  previous_key: Key.describe("The key being replaced (the one peers have pinned)."),
  created: z.number().int().describe("Unix seconds: when the rotation was made."),
  expires: z
    .number()
    .int()
    .describe("Unix seconds: the end of the overlap; after it the statement is not published."),
  sig: z
    .string()
    .max(128)
    .describe("base64url Ed25519 signature by `previous_key` over `keyRotationStatement`."),
});
export type KeyRotation = z.infer<typeof KeyRotation>;

/** `GET /.well-known/openloungephone`. */
export const WellKnown = z.object({
  version: z.number().int().positive(),
  server_key: Key,
  federation: z.string(),
  software: z.string().max(64).optional(),
  /** 0.1 form of a rotation, published alongside `rotation` for 0.1 peers during the overlap. */
  previous_key: Key.optional(),
  rotation_sig: z.string().max(128).optional(),
  rotation: KeyRotation.optional(),
});
export type WellKnown = z.infer<typeof WellKnown>;

/** Clock skew allowed on a rotation's `created` (the same as for signatures). */
const SKEW_S = 300;

export type RotationCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "none" | "not_pinned" | "window" | "expired" | "bad_signature";
    };

/**
 * Whether `doc` hands `host`'s pinned key over to its `server_key` (spec §3.2): a `rotation`
 * whose `previous_key` is the pinned key, created no later than now (±300 s), not expired, with a
 * window of at most 90 days, and signed by the pinned key over `keyRotationStatement`. The 0.1
 * `previous_key`/`rotation_sig` pair alone is not enough: it has no time, so it could be replayed
 * forever.
 */
export async function checkRotation(
  doc: WellKnown,
  pinned: string,
  host: string,
  nowMs: number,
): Promise<RotationCheck> {
  const r = doc.rotation;
  if (!r) return { ok: false, reason: "none" };
  if (r.previous_key !== pinned || doc.server_key === pinned) {
    return { ok: false, reason: "not_pinned" };
  }
  const now = Math.floor(nowMs / 1000);
  if (r.created > now + SKEW_S || r.expires <= r.created) return { ok: false, reason: "window" };
  if (r.expires - r.created > MAX_ROTATION_OVERLAP_S) return { ok: false, reason: "window" };
  if (now >= r.expires) return { ok: false, reason: "expired" };
  const statement = keyRotationStatement({
    host,
    previousKey: pinned,
    newKey: doc.server_key,
    created: r.created,
    expires: r.expires,
  });
  return (await verifyBytes(pinned, statement, r.sig))
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/** A key change is trusted when the pinned key signed a current hand-over (`checkRotation`). */
export async function rotationTrusted(
  doc: WellKnown,
  pinned: string,
  host: string,
  nowMs: number,
): Promise<boolean> {
  return (await checkRotation(doc, pinned, host, nowMs)).ok;
}

/** Signs a hand-over from `previous` to `newKey` for `host`, published for `overlapS` seconds. */
export async function signRotation(
  previous: ServerKey,
  newKey: string,
  host: string,
  created: number,
  overlapS: number,
): Promise<KeyRotation> {
  const expires = created + overlapS;
  const sig = await signBytes(
    previous,
    keyRotationStatement({ host, previousKey: previous.publicKey, newKey, created, expires }),
  );
  return { previous_key: previous.publicKey, created, expires, sig };
}

/**
 * Base URL for a server host. HTTPS always, except `localhost` and `*.localhost` (development and
 * interop tests), which are loopback by definition (RFC 6761).
 */
export function baseUrlFor(host: string): string {
  const name = host.replace(/:\d+$/, "");
  const local = name === "localhost" || name.endsWith(".localhost");
  return `${local ? "http" : "https"}://${host}`;
}
