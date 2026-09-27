/**
 * One-tap virtual phone: when the companion opens this page with `?autopair=1`, the phone pairs
 * itself using the companion's session on this same origin, so nobody types the code.
 */

/** Must match apps/companion/src/session.ts TOKEN_KEY (same origin, same storage). */
export const COMPANION_TOKEN_KEY = "openloungephone.token";

export interface Autopair {
  forMe: boolean;
  name: string;
}

export function parseAutopair(params: URLSearchParams): Autopair | undefined {
  if (params.get("autopair") !== "1") return undefined;
  const name = (params.get("name") ?? "").trim().slice(0, 24) || "My phone";
  return { forMe: params.get("forMe") === "1", name };
}

/** Pair automatically only with a request, a plausible session, and a code not tried before. */
export function shouldAutopair(
  opts: Autopair | undefined,
  token: string | null,
  code: string,
  tried: ReadonlySet<string>,
): opts is Autopair {
  return !!opts && !!token && token.length >= 16 && /^\d{6}$/.test(code) && !tried.has(code);
}

/** Claims `code` for the signed-in companion user. Only ever talks to this origin's API. */
export async function claimPairing(
  code: string,
  opts: Autopair,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl("/api/devices/pair", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code, name: opts.name, forMe: opts.forMe }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
