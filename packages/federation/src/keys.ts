// A server's federation identity: an Ed25519 key pair. The private key is stored as a JWK JSON
// string (Cloudflare secret `FED_PRIVATE_KEY`, or a key file in the self-host DATA_DIR).
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { verifySignature } from "./signature.ts";

export interface ServerKey {
  privateKey: CryptoKey;
  /** Raw Ed25519 public key, base64url (what `.well-known` publishes). */
  publicKey: string;
}

/** A new private key, serialized for storage. */
export async function generateServerKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, d: jwk.d, x: jwk.x });
}

/** Loads a key stored by `generateServerKey`. Throws on anything else. */
export async function loadServerKey(serialized: string): Promise<ServerKey> {
  const jwk = JSON.parse(serialized) as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d || !jwk.x) {
    throw new Error("not an Ed25519 private JWK");
  }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, [
    "sign",
  ]);
  if (fromBase64Url(jwk.x).length !== 32) throw new Error("bad Ed25519 public key");
  return { privateKey, publicKey: jwk.x };
}

export async function signBytes(key: ServerKey, data: string): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(data));
  return toBase64Url(new Uint8Array(sig));
}

export function verifyBytes(publicKey: string, data: string, sig: string): Promise<boolean> {
  try {
    return verifySignature(publicKey, new TextEncoder().encode(data), fromBase64Url(sig));
  } catch {
    return Promise.resolve(false);
  }
}

/** Just the public half of a stored private key (base64url), without importing it. */
export function publicKeyOf(serialized: string): string {
  const x = (JSON.parse(serialized) as JsonWebKey).x;
  if (!x || !/^[A-Za-z0-9_-]{43}$/.test(x)) throw new Error("not an Ed25519 private JWK");
  return x;
}

/**
 * A key's fingerprint for people to compare (like SSH's): `SHA256:` and the base64url SHA-256 of
 * the raw 32-byte public key. Safe to show and log; it reveals nothing secret.
 */
export async function keyFingerprint(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64Url(publicKey));
  return `SHA256:${toBase64Url(new Uint8Array(digest))}`;
}

/**
 * The 0.1 hand-over statement (`rotation_sig`): the old key over the new key alone. Still
 * published during a rotation's overlap for 0.1 peers; newer receivers require `rotation` and
 * `keyRotationStatement` (spec §3.2).
 */
export const rotationStatement = (newKey: string) => `openloungephone-key-rotation:${newKey}`;

/** How long a rotation's statement is published: peers offline longer need their operator. */
export const ROTATION_OVERLAP_S = 7 * 24 * 60 * 60;
/** The longest overlap a receiver accepts (a statement valid forever can't be retired). */
export const MAX_ROTATION_OVERLAP_S = 90 * 24 * 60 * 60;

export interface KeyRotationFields {
  /** The server's host, as in its addresses. */
  host: string;
  previousKey: string;
  newKey: string;
  /** Unix seconds: when the rotation was made, and until when it is published. */
  created: number;
  expires: number;
}

/**
 * What the old key signs to hand over to a new one (`.well-known` `rotation.sig`, spec §3.2):
 * bound to the host, both keys and the overlap window, lines joined by `\n`.
 */
export const keyRotationStatement = (r: KeyRotationFields) =>
  [
    "openloungephone-key-rotation-v2",
    r.host,
    r.previousKey,
    r.newKey,
    String(r.created),
    String(r.expires),
  ].join("\n");
