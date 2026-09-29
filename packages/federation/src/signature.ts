// HTTP Message Signatures (RFC 9421) with Ed25519, for server-to-server requests.
//
// We sign a fixed, small profile:
//   Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=<s>;keyid="<host>";
//                    alg="ed25519";nonce="<random>"
//   Signature:       sig1=:<base64 signature>:
//   Content-Digest:  sha-256=:<base64 digest>:   (RFC 9530; only when there is a body)
// The key id is the sending server's host; its public key comes from that host's
// `/.well-known/openloungephone` (pinned on first use by the caller of `verifyRequest`).
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";

/** Accepted clock skew for `created`. */
export const MAX_SKEW_S = 5 * 60;
/** How long a nonce must be remembered: longer than the whole acceptance window. */
export const NONCE_TTL_MS = 2 * MAX_SKEW_S * 1000 + 60_000;

const LABEL = "sig1";

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** RFC 9530 `Content-Digest` value for a body. */
export async function contentDigest(body: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", body as BufferSource));
  return `sha-256=:${toBase64(d)}:`;
}

export function randomNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

interface Params {
  components: string[];
  created: number;
  keyid: string;
  alg: string;
  nonce: string;
}

function serializeParams(p: Params): string {
  const list = p.components.map((c) => `"${c}"`).join(" ");
  return `(${list});created=${p.created};keyid="${p.keyid}";alg="${p.alg}";nonce="${p.nonce}"`;
}

/** Parses our profile of `Signature-Input` (one label, string parameters without escapes). */
function parseParams(input: string): Params | undefined {
  const m = /^sig1=\(([^)]*)\)((?:;[a-z]+=(?:"[^"\\]*"|\d+))*)$/.exec(input.trim());
  if (!m) return undefined;
  const components = (m[1] ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => (/^"[^"]+"$/.test(c) ? c.slice(1, -1) : ""));
  if (components.some((c) => !c)) return undefined;
  const params = new Map<string, string>();
  for (const part of (m[2] ?? "").split(";").slice(1)) {
    const eq = part.indexOf("=");
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (params.has(k)) return undefined;
    params.set(k, v.startsWith('"') ? v.slice(1, -1) : v);
  }
  const created = Number(params.get("created"));
  const keyid = params.get("keyid");
  const alg = params.get("alg");
  const nonce = params.get("nonce");
  if (!Number.isInteger(created) || !keyid || !alg || !nonce) return undefined;
  return { components, created, keyid, alg, nonce };
}

function signatureBase(
  p: Params,
  values: { method: string; targetUri: string; digest?: string | undefined },
): string | undefined {
  const lines: string[] = [];
  for (const c of p.components) {
    let v: string | undefined;
    if (c === "@method") v = values.method.toUpperCase();
    else if (c === "@target-uri") v = values.targetUri;
    else if (c === "content-digest") v = values.digest;
    if (v === undefined) return undefined;
    lines.push(`"${c}": ${v}`);
  }
  lines.push(`"@signature-params": ${serializeParams(p)}`);
  return lines.join("\n");
}

export interface SignInput {
  method: string;
  /** The full URL being requested. */
  url: string;
  body?: Uint8Array | undefined;
  /** The signing server's host (with port if any). */
  keyId: string;
  privateKey: CryptoKey;
  /** Epoch ms. */
  now: number;
  nonce?: string;
}

/** Headers to add to a request: `signature-input`, `signature`, and `content-digest`. */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const digest = input.body ? await contentDigest(input.body) : undefined;
  const params: Params = {
    components: ["@method", "@target-uri", ...(digest ? ["content-digest"] : [])],
    created: Math.floor(input.now / 1000),
    keyid: input.keyId,
    alg: "ed25519",
    nonce: input.nonce ?? randomNonce(),
  };
  const base = signatureBase(params, {
    method: input.method,
    targetUri: input.url,
    digest,
  }) as string;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", input.privateKey, utf8(base)));
  return {
    "signature-input": `${LABEL}=${serializeParams(params)}`,
    signature: `${LABEL}=:${toBase64(sig)}:`,
    ...(digest ? { "content-digest": digest } : {}),
  };
}

export type VerifyFailure =
  | "missing"
  | "malformed"
  | "alg"
  | "components"
  | "expired"
  | "digest"
  | "replay"
  | "unknown_key"
  | "bad_signature";

export type VerifyResult = { ok: true; keyId: string } | { ok: false; reason: VerifyFailure };

export interface VerifyInput {
  method: string;
  /** The URL as this server is publicly reached (not what a proxy forwarded). */
  url: string;
  headers: { get(name: string): string | null };
  body?: Uint8Array | undefined;
  now: number;
  /**
   * The public key (raw Ed25519, base64url) for a key id, or undefined when it can't be found.
   * `retry` is true on a second call after a signature failed with the first key (rotation).
   */
  resolveKey(keyId: string, retry: boolean): Promise<string | undefined>;
  /** Records a nonce; false if it was already seen (a replay). */
  useNonce(keyId: string, nonce: string, expiresAt: number): Promise<boolean>;
}

export async function verifySignature(
  publicKey: string,
  data: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(publicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sig as BufferSource, data as BufferSource);
  } catch {
    return false;
  }
}

/** Verifies a signed request. Checks, in order: shape, freshness, digest, signature, nonce. */
export async function verifyRequest(input: VerifyInput): Promise<VerifyResult> {
  const sigInput = input.headers.get("signature-input");
  const sigHeader = input.headers.get("signature");
  if (!sigInput || !sigHeader) return { ok: false, reason: "missing" };
  const params = parseParams(sigInput);
  const sigMatch = /^sig1=:([A-Za-z0-9+/]+=*):$/.exec(sigHeader.trim());
  if (!params || !sigMatch) return { ok: false, reason: "malformed" };
  if (params.alg !== "ed25519") return { ok: false, reason: "alg" };
  if (params.nonce.length < 16 || params.nonce.length > 64)
    return { ok: false, reason: "malformed" };
  const hasBody = !!input.body && input.body.byteLength > 0;
  const required = ["@method", "@target-uri", ...(hasBody ? ["content-digest"] : [])];
  if (!required.every((c) => params.components.includes(c))) {
    return { ok: false, reason: "components" };
  }
  if (Math.abs(input.now / 1000 - params.created) > MAX_SKEW_S) {
    return { ok: false, reason: "expired" };
  }
  let digest: string | undefined;
  if (params.components.includes("content-digest")) {
    digest = input.headers.get("content-digest") ?? undefined;
    if (!digest || digest !== (await contentDigest(input.body ?? new Uint8Array()))) {
      return { ok: false, reason: "digest" };
    }
  }
  const base = signatureBase(params, { method: input.method, targetUri: input.url, digest });
  if (!base) return { ok: false, reason: "components" };
  const sig = fromBase64(sigMatch[1] as string);
  let key = await input.resolveKey(params.keyid, false);
  if (!key) return { ok: false, reason: "unknown_key" };
  let good = await verifySignature(key, utf8(base), sig);
  if (!good) {
    // The server may have rotated its key; look again once.
    key = await input.resolveKey(params.keyid, true);
    good = !!key && (await verifySignature(key, utf8(base), sig));
  }
  if (!good) return { ok: false, reason: "bad_signature" };
  // Only a valid signature consumes a nonce, so forged requests can't burn real ones.
  const fresh = await input.useNonce(
    params.keyid,
    params.nonce,
    params.created * 1000 + NONCE_TTL_MS,
  );
  if (!fresh) return { ok: false, reason: "replay" };
  return { ok: true, keyId: params.keyid };
}
