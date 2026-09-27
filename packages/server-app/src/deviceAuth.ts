import type { KeyAlg } from "@opentincan/db";
import { fromBase64Url } from "@opentincan/protocol";

const ALGORITHMS: Record<
  KeyAlg,
  { importParams: EcKeyImportParams | Algorithm; verifyParams: EcdsaParams | Algorithm }
> = {
  ed25519: { importParams: { name: "Ed25519" }, verifyParams: { name: "Ed25519" } },
  // WebCrypto ECDSA signatures are raw r‖s (IEEE P1363), matching the protocol.
  p256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
};

/** Verifies a device signature over `message`. Returns false (never throws) on bad input. */
export async function verifyDeviceSignature(
  alg: KeyAlg,
  publicKeyB64: string,
  signatureB64: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    const { importParams, verifyParams } = ALGORITHMS[alg];
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKeyB64),
      importParams,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(verifyParams, key, fromBase64Url(signatureB64), message);
  } catch {
    return false;
  }
}
