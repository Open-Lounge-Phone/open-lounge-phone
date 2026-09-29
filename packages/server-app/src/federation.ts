// Server-to-server plumbing: this server's identity, other servers' pinned keys, signed
// outbound requests, and the verifying middleware in front of `/fed/v1`.
import {
  baseUrlFor,
  FEDERATION_PATH,
  FEDERATION_VERSION,
  HOST_RE,
  isFederatableHost,
  loadServerKey,
  MAX_FED_BODY_BYTES,
  rotationTrusted,
  type ServerKey,
  signRequest,
  verifyRequest,
  WELL_KNOWN_PATH,
  WellKnown,
} from "@openloungephone/federation";
import type { ServerEnv } from "./env.ts";
import { limitsOf } from "./limits.ts";

export const SOFTWARE = "openloungephone/0.1";

export const DAY_MS = 24 * 60 * 60 * 1000;

const keys = new WeakMap<ServerEnv, Promise<ServerKey>>();

/** This server's key, or undefined when federation isn't configured. */
export function serverKey(env: ServerEnv): Promise<ServerKey> | undefined {
  if (!env.federationKey) return undefined;
  let k = keys.get(env);
  if (!k) {
    k = loadServerKey(env.federationKey);
    keys.set(env, k);
  }
  return k;
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

export async function wellKnownDoc(env: ServerEnv): Promise<WellKnown | undefined> {
  const key = await serverKey(env);
  if (!key) return undefined;
  return {
    version: FEDERATION_VERSION,
    server_key: key.publicKey,
    federation: FEDERATION_PATH,
    software: SOFTWARE,
  };
}

/** Fetches a server's published key. */
async function fetchKey(env: ServerEnv, host: string): Promise<WellKnown | undefined> {
  try {
    const res = await outbound(env)(new Request(`${baseUrlFor(host)}${WELL_KNOWN_PATH}`));
    if (!res.ok) return undefined;
    const doc = WellKnown.safeParse(await res.json());
    return doc.success ? doc.data : undefined;
  } catch (e) {
    env.log("warn", "federation: key fetch failed", { host, error: String(e) });
    return undefined;
  }
}

/**
 * Another server's key, trusted on first use. A different key later is accepted only if the
 * pinned key signed the rotation; otherwise it's refused (and recorded for the operator).
 */
export async function resolveServerKey(
  env: ServerEnv,
  host: string,
  retry: boolean,
): Promise<string | undefined> {
  const store = env.store.connections;
  const pinned = await store.pinnedKey(host);
  if (pinned && !retry) return pinned;
  const doc = await fetchKey(env, host);
  const now = env.now();
  if (!doc) return pinned;
  if (!pinned) {
    await store.pinKey(host, doc.server_key, now);
    return doc.server_key;
  }
  if (doc.server_key === pinned) return pinned;
  if (await rotationTrusted(doc, pinned)) {
    await store.pinKey(host, doc.server_key, now);
    env.log("info", "federation: key rotated", { host });
    return doc.server_key;
  }
  await store.rejectKey(host, doc.server_key, now);
  env.log("warn", "federation: SERVER KEY CHANGED; refusing it", { host });
  return pinned;
}

export class FederationError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
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
  const method = init.method ?? "POST";
  const url = `${baseUrlFor(host)}${FEDERATION_PATH}${path}`;
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
  if (!res.ok) {
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
  if (!(await serverKey(env))) return fail(404, "this server doesn't federate");
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
