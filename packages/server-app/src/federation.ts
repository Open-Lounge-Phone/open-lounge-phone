// Server-to-server plumbing: this server's identity, other servers' pinned keys, signed
// outbound requests, and the verifying middleware in front of `/fed/v1`.
import {
  baseUrlFor,
  checkRotation,
  FEDERATION_PATH,
  HOST_RE,
  isFederatableHost,
  keyFingerprint,
  MAX_FED_BODY_BYTES,
  type ServerKey,
  signRequest,
  VERSION_PATHS,
  verifyRequest,
  WELL_KNOWN_PATH,
  WellKnown,
} from "@openloungephone/federation";
import type { ServerEnv } from "./env.ts";
import { limitsOf } from "./limits.ts";
import { federates, operatorAudit, ownKeys } from "./ownKey.ts";
import { forgetPeer, peerBase, rememberPeer, WELL_KNOWN_MAX_AGE_S } from "./peers.ts";
import { OWN_FEATURES, SOFTWARE, SUPPORTED_VERSIONS } from "./version.ts";

export { SOFTWARE } from "./version.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

/** This server's current signing key, or undefined when federation isn't configured. */
export async function serverKey(env: ServerEnv): Promise<ServerKey | undefined> {
  return (await ownKeys(env))?.current;
}

/** The host in this server's addresses (`handle@host`). */
export function ownHost(env: ServerEnv, requestUrl?: string): string {
  return new URL(env.publicUrl ?? requestUrl ?? "http://localhost").host;
}

/** How this server is reached from outside (for signature target URIs). */
export function ownOrigin(env: ServerEnv, requestUrl: string): string {
  return new URL(env.publicUrl ?? requestUrl).origin;
}

/** Whether this server may contact `host` as another server (see `isFederatableHost`). */
export const federatable = (env: ServerEnv, host: string) => isFederatableHost(host, ownHost(env));

/**
 * Fetch for requests to other servers. Refuses hosts this server must not contact (its own
 * network: loopback, IP literals, local names) before anything is sent.
 */
export const outbound =
  (env: ServerEnv) =>
  (req: Request): Promise<Response> => {
    const host = new URL(req.url).host;
    if (!federatable(env, host)) {
      return Promise.reject(new TypeError(`refused: ${host} is not a public server address`));
    }
    return env.fetch ? env.fetch(req) : fetch(req);
  };

/**
 * `.well-known/openloungephone`. During a rotation's overlap it also carries the previous key
 * and the hand-over (`rotation`, plus the 0.1 `previous_key`/`rotation_sig` pair).
 */
export async function wellKnownDoc(env: ServerEnv): Promise<WellKnown | undefined> {
  const keys = await ownKeys(env);
  if (!keys) return undefined;
  const r = keys.rotation;
  return {
    version: Math.max(...SUPPORTED_VERSIONS),
    server_key: keys.current.publicKey,
    federation: FEDERATION_PATH,
    software: SOFTWARE,
    versions: Object.fromEntries(
      SUPPORTED_VERSIONS.map((v) => [String(v), VERSION_PATHS[v] as string]),
    ),
    features: [...OWN_FEATURES],
    ...(r
      ? {
          previous_key: r.previous_key,
          rotation_sig: r.legacy_sig,
          rotation: {
            previous_key: r.previous_key,
            created: r.created,
            expires: r.expires,
            sig: r.sig,
          },
        }
      : {}),
  };
}

/** `max-age` of a `Cache-Control` header, clamped to 1 minute … 1 hour (default 5 minutes). */
function maxAgeOf(res: Response): number {
  const m = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "");
  const s = m ? Number(m[1]) : WELL_KNOWN_MAX_AGE_S;
  return Math.min(3600, Math.max(60, s));
}

/**
 * Fetches a server's `.well-known` (its key, versions and features) and refreshes the cached
 * copy that version negotiation uses (`peers.ts`).
 */
export async function fetchWellKnown(env: ServerEnv, host: string): Promise<WellKnown | undefined> {
  try {
    const res = await outbound(env)(new Request(`${baseUrlFor(host)}${WELL_KNOWN_PATH}`));
    if (!res.ok) return undefined;
    const doc = WellKnown.safeParse(await res.json());
    if (!doc.success) {
      env.log("warn", "federation: unreadable .well-known", { host });
      return undefined;
    }
    await rememberPeer(env, host, doc.data, maxAgeOf(res));
    return doc.data;
  } catch (e) {
    env.log("warn", "federation: .well-known fetch failed", { host, error: String(e) });
    return undefined;
  }
}

/**
 * Another server's key, trusted on first use. A different key later is accepted only if the
 * pinned key signed a current hand-over (`checkRotation`); otherwise it's refused and recorded
 * for the operator, who may re-trust it. Both outcomes go into the operators' audit trail.
 */
export async function resolveServerKey(
  env: ServerEnv,
  host: string,
  retry: boolean,
): Promise<string | undefined> {
  const store = env.store.connections;
  const pinned = await store.pinnedKey(host);
  if (pinned && !retry) return pinned;
  const doc = await fetchWellKnown(env, host);
  const now = env.now();
  if (!doc) return pinned;
  if (!pinned) {
    await store.pinKey(host, doc.server_key, now);
    return doc.server_key;
  }
  if (doc.server_key === pinned) return pinned;
  const check = await checkRotation(doc, pinned, host, now);
  const change = async () => ({
    host,
    from: await keyFingerprint(pinned),
    to: await keyFingerprint(doc.server_key),
  });
  if (check.ok) {
    if (await store.repinKey(host, pinned, doc.server_key, now)) {
      env.log("info", "federation: key rotated", { host });
      await operatorAudit(env, null, "fedkey.rotated", await change());
    }
    return doc.server_key;
  }
  if (await store.rejectKey(host, doc.server_key, now)) {
    await operatorAudit(env, null, "fedkey.refused", { ...(await change()), reason: check.reason });
  }
  env.log("warn", "federation: SERVER KEY CHANGED; refusing it", { host, reason: check.reason });
  return pinned;
}

export class FederationError extends Error {
  readonly status: number;
  /** Why, when the caller words it for people: no common version, or a missing endpoint. */
  readonly code: "no_common_version" | "not_supported" | undefined;
  constructor(status: number, message: string, code?: "no_common_version" | "not_supported") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A note for people when a request to another server failed for version reasons, if it did. */
export function versionNote(e: unknown): string | undefined {
  if (!(e instanceof FederationError)) return undefined;
  if (e.code === "no_common_version") return e.message;
  if (e.code === "not_supported") return "That server doesn't support this yet";
  return undefined;
}

/** Sends a signed request to another server. Throws FederationError on failure. */
export async function fedFetch(
  env: ServerEnv,
  host: string,
  path: string,
  init: { method?: string; json?: unknown; body?: Uint8Array; contentType?: string } = {},
): Promise<Response> {
  const key = await serverKey(env);
  if (!key || !env.publicUrl) {
    throw new FederationError(400, "this server isn't set up to talk to other servers");
  }
  if (!HOST_RE.test(host) || !federatable(env, host)) {
    throw new FederationError(400, "not a server address");
  }
  if (await env.store.connections.serverBlocked(host)) {
    throw new FederationError(403, "this server doesn't talk to that server");
  }
  const base = await peerBase(env, host);
  if (!base.ok) throw new FederationError(502, base.message, "no_common_version");
  const method = init.method ?? "POST";
  const url = `${baseUrlFor(host)}${base.base}${path}`;
  const body =
    init.body ??
    (init.json !== undefined ? new TextEncoder().encode(JSON.stringify(init.json)) : undefined);
  const headers = await signRequest({
    method,
    url,
    body,
    keyId: ownHost(env),
    privateKey: key.privateKey,
    now: env.now(),
  });
  let res: Response;
  try {
    res = await outbound(env)(
      new Request(url, {
        method,
        headers: {
          ...headers,
          ...(body ? { "content-type": init.contentType ?? "application/json" } : {}),
        },
        ...(body ? { body: body as BodyInit } : {}),
      }),
    );
  } catch (e) {
    env.log("warn", "federation: request failed", { host, path, error: String(e) });
    throw new FederationError(502, `couldn't reach ${host}`);
  }
  if (res.status === 429) throw new FederationError(429, `${host} is busy; try again later`);
  if (res.status === 404) {
    // An endpoint the peer doesn't have (older software), or it stopped federating: look at its
    // `.well-known` again next time instead of trusting the cached copy.
    await forgetPeer(env, host);
    throw new FederationError(502, `${host} doesn't support this yet`, "not_supported");
  }
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) await forgetPeer(env, host);
    throw new FederationError(502, `${host} refused the request (${res.status})`);
  }
  return res;
}

export type FedVerified =
  | { ok: true; host: string; body: Uint8Array }
  | { ok: false; response: Response };

/**
 * Verifies an inbound `/fed/v1` request: size, signature (pinned key, ±5 min, single-use nonce),
 * the operator's server blocklist, and the per-server request budget.
 */
export async function verifyFedRequest(
  env: ServerEnv,
  req: Request,
  maxBytes = MAX_FED_BODY_BYTES,
): Promise<FedVerified> {
  const fail = (status: number, error: string, headers?: Record<string, string>) => ({
    ok: false as const,
    response: Response.json({ error }, { status, ...(headers ? { headers } : {}) }),
  });
  if (!federates(env)) return fail(404, "this server doesn't federate");
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return fail(413, "too large");
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > maxBytes) return fail(413, "too large");
  const url = new URL(req.url);
  const store = env.store.connections;
  const now = env.now();
  const result = await verifyRequest({
    method: req.method,
    url: `${ownOrigin(env, req.url)}${url.pathname}${url.search}`,
    headers: req.headers,
    body,
    now,
    resolveKey: (host, retry) =>
      federatable(env, host) ? resolveServerKey(env, host, retry) : Promise.resolve(undefined),
    useNonce: (host, nonce, expiresAt) => store.useNonce(`${host} ${nonce}`, expiresAt, now),
  });
  if (!result.ok) {
    env.log("warn", "federation: rejected request", { reason: result.reason, path: url.pathname });
    return fail(401, `signature: ${result.reason}`);
  }
  const host = result.keyId;
  if (await store.serverBlocked(host)) return fail(403, "blocked");
  if (!(await store.hit(`fed:${host}`, 60_000, limitsOf(env).fedRequestsPerMinute, now))) {
    return fail(429, "slow down", { "retry-after": "60" });
  }
  return { ok: true, host, body };
}
