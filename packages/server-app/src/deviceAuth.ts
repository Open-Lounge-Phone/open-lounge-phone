import { fromBase64Url } from "@opentincan/protocol";

/** Verifies an Ed25519 signature over `message`. Returns false (never throws) on bad input. */
export async function verifyEd25519(
  publicKeyB64: string,
  signatureB64: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKeyB64),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, fromBase64Url(signatureB64), message);
  } catch {
    return false;
  }
}
