/** Handles as the server validates them (see `@openloungephone/db` HANDLE_RE). */
export const HANDLE_RE = /^[a-z0-9._-]{2,30}$/;
/** A host name with an optional port; no scheme, path or user info. */
export const HOST_RE =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

export interface Address {
  handle: string;
  host: string;
}

/** Parses `handle@host` (case-insensitive, surrounding space and a leading "@" ignored). */
export function parseAddress(text: string): Address | undefined {
  const t = text.trim().toLowerCase().replace(/^@/, "");
  const at = t.lastIndexOf("@");
  if (at <= 0) return undefined;
  const handle = t.slice(0, at);
  const host = t.slice(at + 1);
  if (!HANDLE_RE.test(handle) || !HOST_RE.test(host)) return undefined;
  return { handle, host };
}

export const formatAddress = (a: Address) => `${a.handle}@${a.host}`;
