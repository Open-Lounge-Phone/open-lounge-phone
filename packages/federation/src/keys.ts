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

/** What the old key signs to hand over to a new one (published in `.well-known`). */
export const rotationStatement = (newKey: string) => `openloungephone-key-rotation:${newKey}`;
