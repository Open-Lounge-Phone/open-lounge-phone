import type { IceServer } from "@opentincan/protocol";

/**
 * Time-limited TURN credentials in the "TURN REST API" scheme understood by coturn's
 * `use-auth-secret` / `static-auth-secret`: username = expiry, password = HMAC-SHA1(secret, username).
 */
export async function turnRestCredentials(
  secret: string,
  now: number,
  ttlSeconds = 6 * 60 * 60,
): Promise<{ username: string; credential: string }> {
  const username = `${Math.floor(now / 1000) + ttlSeconds}:opentincan`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)),
  );
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return { username, credential: btoa(bin) };
}

export interface IceConfig {
  stunUrls: string[];
  turnUrls: string[];
  turnSecret?: string;
}

export async function buildIceServers(cfg: IceConfig, now: number): Promise<IceServer[]> {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length && cfg.turnSecret) {
    servers.push({ urls: cfg.turnUrls, ...(await turnRestCredentials(cfg.turnSecret, now)) });
  }
  return servers;
}
