import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fairUseFromVars, hubInfoFromVars, relayFromVars } from "@openloungephone/server-app";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** All configuration comes from environment variables; see `.env.example`. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 8787);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDir: resolve(env.DATA_DIR ?? resolve(repoRoot, "data")),
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    /** Only an explicit PUBLIC_URL pins passkeys to a host; otherwise the request host is used. */
    publicUrlExplicit: env.PUBLIC_URL !== undefined,
    /** OPEN_SIGNUP=1: anyone can create an account (and their own household). Off by default. */
    openSignup: env.OPEN_SIGNUP === "1" || env.OPEN_SIGNUP === "true",
    /** Fair-use allowance: FAIR_USE=hub and/or FAIR_USE_* (unlimited when unset). */
    fairUse: fairUseFromVars(env),
    /** Rooms' media relay: LIVEKIT_URL/_API_KEY/_API_SECRET (or SFU_APP_ID/_SECRET); else mesh. */
    relay: relayFromVars(env),
    /** Cloudflare Turnstile on sign-up, when both keys are set. */
    turnstile:
      env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET
        ? { siteKey: env.TURNSTILE_SITE_KEY, secret: env.TURNSTILE_SECRET }
        : undefined,
    /** Handles of this server's operators (the admin view). */
    operators: list(env.OPERATORS).map((h) => h.toLowerCase()),
    /** Funding transparency and the Sponsor link (public hubs). */
    hub: hubInfoFromVars(env),
    /** Trust X-Forwarded-For for client IPs (only behind your own reverse proxy). */
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    /** REFUSE_RECORDED_CALLS=1: other servers' recorded calls don't reach this server's people. */
    refuseRecordedCalls: env.REFUSE_RECORDED_CALLS === "1" || env.REFUSE_RECORDED_CALLS === "true",
    /** Federation (connections with other servers) is on unless FEDERATION=0. */
    federation: env.FEDERATION !== "0" && env.FEDERATION !== "false",
    transcribe: env.TRANSCRIBE_URL
      ? {
          url: env.TRANSCRIBE_URL,
          model: env.TRANSCRIBE_MODEL ?? "whisper-1",
          ...(env.TRANSCRIBE_API_KEY ? { apiKey: env.TRANSCRIBE_API_KEY } : {}),
        }
      : undefined,
    companionDir: resolve(env.COMPANION_DIR ?? resolve(repoRoot, "apps/companion/dist")),
    deviceDir: resolve(env.DEVICE_DIR ?? resolve(repoRoot, "apps/device-web/dist")),
    ice: {
      // Empty STUN_URLS disables STUN entirely (LAN-only installs).
      stunUrls:
        env.STUN_URLS === undefined ? ["stun:stun.cloudflare.com:3478"] : list(env.STUN_URLS),
      turnUrls: list(env.TURN_URLS),
      ...(env.TURN_SECRET ? { turnSecret: env.TURN_SECRET } : {}),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
