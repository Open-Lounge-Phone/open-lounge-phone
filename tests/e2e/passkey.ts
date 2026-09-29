// A software passkey for end-to-end tests: answers a WebAuthn registration challenge with a
// "none" attestation, as a browser authenticator would.
import { toBase64Url } from "@openloungephone/protocol";

/** Minimal CBOR encoder (ints, byte/text strings, maps). */
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): number[] =>
    n < 24
      ? [(major << 5) | n]
      : n < 256
        ? [(major << 5) | 24, n]
        : [(major << 5) | 25, n >> 8, n & 0xff];
  const parts: number[] = [];
  const put = (v: unknown): void => {
    if (typeof v === "number") parts.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      parts.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) parts.push(...head(2, v.length), ...v);
    else if (v instanceof Map) {
      parts.push(...head(5, v.size));
      for (const [k, val] of v) {
        put(k);
        put(val);
      }
    } else throw new Error("unsupported");
  };
  put(value);
  return new Uint8Array(parts);
}

export async function fakeRegistration(
  options: { challenge: string; rp: { id: string } },
  origin: string,
) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.slice(1, 33)],
      [-3, raw.slice(33, 65)],
    ]),
  );
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(options.rp.id)),
  );
  const authData = new Uint8Array([
    ...rpIdHash,
    0x45,
    0,
    0,
    0,
    0,
    ...new Uint8Array(16),
    0,
    credId.length,
    ...credId,
    ...cose,
  ]);
  const clientData = JSON.stringify({
    type: "webauthn.create",
    challenge: options.challenge,
    origin,
    crossOrigin: false,
  });
  const id = toBase64Url(credId);
  return {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64Url(new TextEncoder().encode(clientData)),
      attestationObject: toBase64Url(
        cbor(
          new Map<string, unknown>([
            ["fmt", "none"],
            ["attStmt", new Map()],
            ["authData", authData],
          ]),
        ),
      ),
      transports: ["internal"],
    },
  };
}
