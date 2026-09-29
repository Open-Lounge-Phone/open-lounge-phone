/** Session token persistence and first-run setup link parsing. */
import { type LoungeLink, parseLoungeLink } from "./loungeLink.ts";

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

/** Everything a link can carry in the page's hash: setup, invite and Lounge-phone links. */
export interface HashLinks {
  setup?: string;
  invite?: string;
  lounge?: LoungeLink;
}

/**
 * Reads the hash links. Used on first load and again on every `hashchange`, so opening a second
 * link in an already-open app (pasting `#invite=…`, scanning a Lounge code) still works.
 */
export function readHashLinks(pathname: string, hash: string): HashLinks {
  const setup = readSetupToken(hash);
  const invite = readInviteToken(hash);
  const lounge = parseLoungeLink(pathname, hash);
  return {
    ...(setup ? { setup } : {}),
    ...(invite ? { invite } : {}),
    ...(lounge ? { lounge } : {}),
  };
}
