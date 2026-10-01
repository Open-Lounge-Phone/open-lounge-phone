// What other servers speak (spec §9): each peer's `.well-known` is cached (store table
// `server_info`, for its `Cache-Control` max-age), negotiated to the highest common federation
// version, and asked before an optional feature is used with it. Refreshed when a key change makes
// us fetch it anyway, and dropped after a peer answers an error.
import { LOCAL_HOST } from "@openloungephone/db";
import {
  type Feature,
  negotiate,
  noCommonVersion,
  type PeerOffer,
  peerOffer,
  WellKnown,
} from "@openloungephone/federation";
import type { ServerEnv } from "./env.ts";
import { federatable, fetchWellKnown } from "./federation.ts";
import { SUPPORTED_VERSIONS } from "./version.ts";

/** How long a `.well-known` is cached when the peer doesn't say (its own default max-age). */
export const WELL_KNOWN_MAX_AGE_S = 300;
/** After a failed fetch, a stale copy is used for this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Stores a freshly fetched `.well-known`. */
export async function rememberPeer(
  env: ServerEnv,
  host: string,
  doc: WellKnown,
  maxAgeS: number,
): Promise<void> {
  const now = env.now();
  await env.store.connections.saveServerInfo(host, JSON.stringify(doc), now, now + maxAgeS * 1000);
}

/** The next use of `host` fetches its `.well-known` again. */
export async function forgetPeer(env: ServerEnv, host: string): Promise<void> {
  await env.store.connections.expireServerInfo(host, env.now());
}

/**
 * What `host` offers: the cached document while fresh, else a new fetch, else the stale copy
 * (retried a minute later). With nothing at all — the peer can't be reached right now — it is
 * treated as a 0.1 server, which is what every server was before versions were advertised; the
 * request itself will then fail or succeed on its own.
 */
export async function peerOfferOf(env: ServerEnv, host: string): Promise<PeerOffer> {
  const store = env.store.connections;
  const cached = await store.serverInfo(host);
  const now = env.now();
  const parse = (raw: string) => {
    try {
      const doc = WellKnown.safeParse(JSON.parse(raw));
      return doc.success ? doc.data : undefined;
    } catch {
      return undefined;
    }
  };
  const fresh = cached && cached.expiresAt > now ? parse(cached.doc) : undefined;
  if (fresh) return peerOffer(fresh);
  const fetched = federatable(env, host) ? await fetchWellKnown(env, host) : undefined;
  if (fetched) return peerOffer(fetched);
  const stale = cached ? parse(cached.doc) : undefined;
  if (stale && cached) {
    await store.saveServerInfo(host, cached.doc, cached.fetchedAt, now + RETRY_AFTER_FAILURE_MS);
    return peerOffer(stale);
  }
  return peerOffer({ version: 1, server_key: "", federation: "/fed/v1" } as WellKnown);
}

export type PeerBase = { ok: true; version: number; base: string } | { ok: false; message: string };

/** The base path to use with `host`: its path for the highest version both servers speak. */
export async function peerBase(env: ServerEnv, host: string): Promise<PeerBase> {
  const n = negotiate(await peerOfferOf(env, host), SUPPORTED_VERSIONS);
  if (n.ok) return { ok: true, version: n.version, base: n.base };
  const message = noCommonVersion(host, n);
  env.log("warn", "federation: no common version", { host, ours: n.ours, theirs: n.theirs });
  return { ok: false, message };
}

/**
 * Whether `host` advertises an optional feature. Another household on this server (host '')
 * always has everything this server has.
 */
export async function peerSupports(
  env: ServerEnv,
  host: string | undefined,
  feature: Feature,
): Promise<boolean> {
  if (!host || host === LOCAL_HOST) return true;
  return (await peerOfferOf(env, host)).features.has(feature);
}

/** What people are told when a feature isn't available with the other server. */
export const UNAVAILABLE: Record<Feature, string> = {
  rooms: "Rooms aren't available with that server yet",
  "recording-flag":
    "This call would be recorded, and that server can't announce recordings yet, so it wasn't placed",
  "lounge-guests": "Lounge guests aren't available with that server yet",
  "key-rotation": "That server can't follow a key rotation yet",
  "voicemail-greeting": "That server can't share greetings yet",
  "presence-batch": "That server doesn't share availability yet",
  transfer: "Transfers aren't available with that server yet",
};

/** Every peer's last known offer (for the operator's view), without fetching anything. */
export async function knownOffers(env: ServerEnv): Promise<Map<string, PeerOffer>> {
  const out = new Map<string, PeerOffer>();
  for (const row of await env.store.connections.serverInfos()) {
    try {
      const doc = WellKnown.safeParse(JSON.parse(row.doc));
      if (doc.success) out.set(row.host, peerOffer(doc.data));
    } catch {
      // A cache row that doesn't parse is simply unknown.
    }
  }
  return out;
}
