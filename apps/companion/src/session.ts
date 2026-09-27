/** Session token persistence and first-run setup link parsing. */

export const TOKEN_KEY = "opentincan.token";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadToken(storage: Store): string | null {
  const t = storage.getItem(TOKEN_KEY);
  return t && t.length >= 16 ? t : null;
}

export function saveToken(storage: Store, token: string | null): void {
  if (token) storage.setItem(TOKEN_KEY, token);
  else storage.removeItem(TOKEN_KEY);
}

/** Extracts the one-time token from a `#setup=<token>` hash. */
export function readSetupToken(hash: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("setup")?.trim();
  return token ? token : undefined;
}

export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
