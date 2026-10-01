// Versions and features (spec §9). A federation *version* is wire compatibility: the paths, the
// signature profile, the stream handshake and every field's meaning. *Features* are optional
// capabilities within a version, advertised in `.well-known` and used with a peer only when it
// lists them. Both are negotiated per peer from its `.well-known` (see `negotiate`).
import type { WellKnown } from "./wellKnown.ts";

/** Federation versions this implementation speaks, oldest first. */
export const SUPPORTED_VERSIONS: readonly number[] = [1];

/** Base path of each supported version. */
export const VERSION_PATHS: Readonly<Record<number, string>> = { 1: "/fed/v1" };

/**
 * The features registry. Names are lower case with dashes; receivers ignore names they don't
 * know. A feature never changes meaning once registered; a feature that needs a different meaning
 * gets a new name.
 */
export const FEATURES = {
  rooms:
    "Phone rooms across servers: `POST /fed/v1/rooms/join`, `room.signal` stream frames, and 3-way merges that turn a call into a room leg (`call.state.merged`).",
  "recording-flag":
    "Recorded calls: `CallBody.recording`, the `call.state.recording` notice, and refusing recorded calls with `denied` + `note`. A server never places or keeps a recorded call with a peer that doesn't list it.",
  "lounge-guests":
    "Guests at another server's Lounge phone: `/fed/v1/lounge/{claim,progress,dial,leave}`, the `guest` call target, `CallBody.guestOf`/`ringLabel`.",
  "key-rotation":
    "Publishes and verifies the timed key hand-over (`.well-known.rotation`, statement `openloungephone-key-rotation-v2`, §3.2).",
  "voicemail-greeting":
    "`POST /fed/v1/greeting`: the callee's greeting for a caller whose call went to voicemail. Without it the caller hears the spoken default greeting.",
  "presence-batch":
    "`POST /fed/v1/presence` with `to` listing all of the sender's connections on the receiving server in one request.",
  transfer:
    "Transfers across servers: `call.state ended` + `transfer` hands a call over to a new call id with the same server (team and organization spaces).",
} as const satisfies Record<string, string>;

export type Feature = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as Feature[];

/**
 * What a `.well-known` without `features` means: a server from before features were advertised
 * (Open Lounge Phone 0.1), which implements all of these. Assuming less would cut 0.1 peers off
 * from things they do today.
 */
export const LEGACY_FEATURES: readonly Feature[] = [
  "rooms",
  "recording-flag",
  "lounge-guests",
  "key-rotation",
  "voicemail-greeting",
  "presence-batch",
  "transfer",
];

/** What a peer offers, read from its `.well-known` (nothing here is trusted for authority). */
export interface PeerOffer {
  /** Version → base path. */
  versions: Record<number, string>;
  features: ReadonlySet<string>;
  /** The document predates `versions`/`features` (an 0.1 server): legacy defaults apply. */
  legacy: boolean;
  software?: string;
}

/** A base path we are willing to send requests to: plain segments, no dots, no query. */
const SAFE_PATH = /^(?=.{2,64}$)(\/[A-Za-z0-9_-]+)+$/;

/** Reads versions and features from a peer's `.well-known`, applying the 0.1 defaults. */
export function peerOffer(doc: WellKnown): PeerOffer {
  const versions: Record<number, string> = {};
  if (doc.versions) {
    for (const [k, path] of Object.entries(doc.versions)) {
      const v = Number(k);
      if (Number.isSafeInteger(v) && v > 0 && SAFE_PATH.test(path)) versions[v] = path;
    }
  }
  // `version` + `federation` say the same for documents that predate `versions`: `federation`
  // has always been the base path of version 1.
  if (!doc.versions && SAFE_PATH.test(doc.federation)) versions[1] = doc.federation;
  const legacy = doc.features === undefined;
  return {
    versions,
    features: new Set(legacy ? LEGACY_FEATURES : doc.features),
    legacy,
    ...(doc.software ? { software: doc.software } : {}),
  };
}

export type Negotiation =
  | { ok: true; version: number; base: string }
  | { ok: false; ours: number[]; theirs: number[] };

/** The highest version both sides speak, with the peer's base path for it. */
export function negotiate(
  offer: Pick<PeerOffer, "versions">,
  ours: readonly number[] = SUPPORTED_VERSIONS,
): Negotiation {
  const theirs = Object.keys(offer.versions)
    .map(Number)
    .sort((a, b) => a - b);
  const common = theirs.filter((v) => ours.includes(v));
  const version = common.at(-1);
  if (version === undefined) return { ok: false, ours: [...ours], theirs };
  return { ok: true, version, base: offer.versions[version] as string };
}

/** Plain words for a failed negotiation, shown to people and written to the log. */
export function noCommonVersion(host: string, n: { ours: number[]; theirs: number[] }): string {
  if (!n.theirs.length) return `${host} doesn't offer a federation version this server can use`;
  const theirs = n.theirs.join(", ");
  const s = n.theirs.length > 1 ? "s" : "";
  const newer = Math.min(...n.theirs) > Math.max(...n.ours);
  return newer
    ? `${host} only speaks a newer federation version${s} (${theirs}); this server needs an update to talk to it`
    : `${host} only speaks ${s ? "older federation versions" : "an older federation version"} (${theirs}), which this server no longer supports; that server needs an update`;
}
