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

/**
 * `GET /.well-known/openloungephone`. Only `version`, `server_key` and `federation` must be valid
 * for the document to be usable; an optional field a receiver can't read is dropped (`.catch`), so
 * a newer server's richer document never stops an older one from verifying its key.
 */
export const WellKnown = z.object({
  version: z
    .number()
    .int()
    .positive()
    .describe("The highest federation version the server speaks."),
  server_key: Key.describe("Raw 32-byte Ed25519 public key, base64url."),
  federation: z.string().describe("Base path of version 1 (`/fed/v1`)."),
  software: z
    .string()
    .max(64)
    .optional()
    .catch(undefined)
    .describe("Implementation and its version, e.g. `openloungephone/0.2.0`. Informational."),
  versions: z
    // Lenient on purpose: an entry this server can't read is skipped, not fatal.
    .preprocess((v) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) return v;
      const ok = Object.entries(v)
        .filter(([k, p]) => /^[1-9]\d{0,3}$/.test(k) && typeof p === "string")
        .slice(0, 16);
      // Nothing readable: as if absent (version 1 at `federation`).
      return ok.length ? Object.fromEntries(ok) : undefined;
    }, z.record(z.string().regex(/^[1-9]\d{0,3}$/), z.string().max(64)).optional())
    .optional()
    .catch(undefined)
    .describe(
      'Every federation version the server speaks → its base path, e.g. `{"1": "/fed/v1"}` (§9). Absent: version 1 at `federation`.',
    ),
  features: z
    // Lenient on purpose: names this server can't hold are skipped, not fatal.
    .preprocess(
      (v) =>
        Array.isArray(v)
          ? v.filter((x) => typeof x === "string" && x.length <= 32).slice(0, 64)
          : v,
      z.array(z.string().max(32)).max(64),
    )
    .optional()
    .catch(undefined)
    .describe(
      "Optional capabilities the server supports (§9.2). Unknown names are ignored. Absent: the 0.1 set.",
    ),
  /** 0.1 form of a rotation, published alongside `rotation` for 0.1 peers during the overlap. */
  previous_key: Key.optional().catch(undefined),
  rotation_sig: z.string().max(128).optional().catch(undefined),
  rotation: KeyRotation.optional().catch(undefined),
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
