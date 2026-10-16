// How this server is set up, for its operators' "This server" card: every setting that isn't a
// secret, as plain facts. Secrets (TURN keys, the SFU or LiveKit secret, Turnstile's secret, the
// federation private key, transcription API keys) are never returned: only whether they're set.
import { keyFingerprint, SUPPORTED_VERSIONS } from "@openloungephone/federation";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openloungephone/protocol";
import type { ServerEnv } from "./env.ts";
import { DEFAULT_LIMITS, type FairUse, type Limits } from "./limits.ts";
import { federates, ownKeys } from "./ownKey.ts";
import { advertisedFeatures, SERVER_VERSION } from "./version.ts";

export interface ServerSettings {
  version: { server: string; protocol: { min: number; max: number }; federation: number[] };
  signup: { open: boolean; turnstile: boolean };
  addons: boolean;
  /** null = no allowance (unlimited). */
  fairUse: FairUse | null;
  calls: { turn: boolean; rooms: "sfu" | "livekit" | "mesh" };
  transcription: boolean;
  recording: { spacesMayRecord: true; refuseOtherServersRecordedCalls: boolean };
  /** null: taken from each request (no PUBLIC_URL). */
  publicUrl: string | null;
  federation: { on: boolean; fingerprint: string | null; features: string[] };
  funding: { balanceUsd: number } | null;
  sponsorUrl: string | null;
  /** Each operator by handle and name; `handle: null` = an id that matches no account here. */
  operators: { handle: string | null; name: string | null }[];
  trustProxy: boolean;
  /** Rate limits changed from the defaults (name → value). */
  limits: Partial<Limits>;
}

export async function serverSettings(env: ServerEnv): Promise<ServerSettings> {
  const fed = federates(env) && !!env.publicUrl;
  const keys = fed ? await ownKeys(env).catch(() => undefined) : undefined;
  const relay = env.relay?.kind;
  const changed = Object.fromEntries(
    Object.entries(env.limits ?? {}).filter(
      ([k, v]) => v !== undefined && DEFAULT_LIMITS[k as keyof Limits] !== v,
    ),
  ) as Partial<Limits>;
  return {
    version: {
      server: SERVER_VERSION,
      protocol: { min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      federation: [...SUPPORTED_VERSIONS],
    },
    signup: { open: env.openSignup === true, turnstile: !!env.turnstile },
    addons: env.addons === true,
    fairUse: env.fairUse ? { ...env.fairUse } : null,
    calls: {
      turn: env.turn === true,
      rooms: relay === "cloudflare" ? "sfu" : relay === "livekit" ? "livekit" : "mesh",
    },
    transcription: !!env.transcriber,
    recording: {
      spacesMayRecord: true,
      refuseOtherServersRecordedCalls: env.refuseRecordedCalls === true,
    },
    publicUrl: env.publicUrl ?? null,
    federation: {
      on: fed,
      fingerprint: keys ? await keyFingerprint(keys.current.publicKey) : null,
      features: fed ? [...advertisedFeatures(env)] : [],
    },
    funding: env.hub?.funding ? { balanceUsd: env.hub.funding.balanceUsd } : null,
    sponsorUrl: env.hub?.sponsorUrl ?? null,
    operators: await Promise.all(
      (env.operators ?? []).map(async (id) => {
        const a = await env.store.getAccount(id);
        return { handle: a?.handle ?? null, name: a?.name ?? null };
      }),
    ),
    trustProxy: env.trustProxy === true,
    limits: changed,
  };
}
