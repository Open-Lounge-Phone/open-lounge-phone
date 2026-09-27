/** Session token persistence and first-run setup link parsing. */

export const TOKEN_KEY = "openloungephone.token";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadToken(storage: Store): string | null {
  const t = storage.getItem(TOKEN_KEY);
  return t && t.length >= 16 ? t : null;
}

export function saveToken(storage: Store, token: string | null): void {
  if (token) storage.setItem(TOKEN_KEY, token);
  else storage.removeItem(TOKEN_KEY);
}

function readHashParam(hash: string, key: string): string | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

/** Extracts the one-time token from a `#setup=<token>` hash. */
export function readSetupToken(hash: string): string | undefined {
  return readHashParam(hash, "setup");
}

/** Extracts the invite token from a `#invite=<token>` hash. */
export function readInviteToken(hash: string): string | undefined {
  return readHashParam(hash, "invite");
}

/** The link a guardian shares; the token stays in the fragment so it never reaches server logs. */
export function inviteLink(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/#invite=${encodeURIComponent(token)}`;
}

export function defaultTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
