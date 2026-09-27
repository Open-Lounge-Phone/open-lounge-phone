import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
