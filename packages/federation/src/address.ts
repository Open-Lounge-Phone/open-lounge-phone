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

const hostName = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

/** `localhost` and `*.localhost` (RFC 6761): development and interop tests only. */
export function isLoopbackHost(host: string): boolean {
  const name = hostName(host);
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * Whether a server at `ownHost` may contact `host` as another server. A server with a public
 * name only talks to public DNS names: never loopback names, IP literals, single-label names, or
 * names reserved for local networks (`.local`, `.internal`, `.lan`, `.home.arpa`, `.localdomain`).
 * Otherwise an address someone types (`x@127.0.0.1:6379`) or a request's `keyid` would make the
 * server send requests into its own network. A server that is itself on a loopback name (a
 * developer's machine, the interop tests) may talk to other loopback servers.
 */
export function isFederatableHost(host: string, ownHost: string): boolean {
  if (!HOST_RE.test(host)) return false;
  const name = hostName(host);
  if (isLoopbackHost(host)) return isLoopbackHost(ownHost);
  if (/^[\d.]+$/.test(name)) return false;
  if (!name.includes(".")) return false;
  return !/\.(local|internal|lan|home\.arpa|localdomain)$/.test(name);
}
