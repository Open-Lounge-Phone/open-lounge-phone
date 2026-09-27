import { toBase64Url } from "@opentincan/protocol";

/** Random URL-safe id with a readable prefix, e.g. `dev_Xk3...`. 96 bits of entropy. */
export function newId(prefix: string): string {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** 256-bit bearer secret. */
export function newToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toBase64Url(new Uint8Array(digest));
}

/** Uniform random 6-digit numeric code (rejection sampling avoids modulo bias). */
export function newPairingCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buf);
  while ((buf[0] ?? limit) >= limit);
  return String((buf[0] as number) % 1_000_000).padStart(6, "0");
}
