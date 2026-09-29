import { z } from "zod";
import { rotationStatement, verifyBytes } from "./keys.ts";

export const WELL_KNOWN_PATH = "/.well-known/openloungephone";
export const FEDERATION_PATH = "/fed/v1";
export const FEDERATION_VERSION = 1;

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** `GET /.well-known/openloungephone`. */
export const WellKnown = z.object({
  version: z.number().int().positive(),
  server_key: Key,
  federation: z.string(),
  software: z.string().max(64).optional(),
  /** Set after a key rotation: the old key signed `rotationStatement(server_key)`. */
  previous_key: Key.optional(),
  rotation_sig: z.string().max(128).optional(),
});
export type WellKnown = z.infer<typeof WellKnown>;

/** A key change is trusted when the pinned key signed the hand-over to the new one. */
export async function rotationTrusted(doc: WellKnown, pinned: string): Promise<boolean> {
  if (doc.previous_key !== pinned || !doc.rotation_sig) return false;
  return verifyBytes(pinned, rotationStatement(doc.server_key), doc.rotation_sig);
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
