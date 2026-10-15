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

/** An add-on's name, the part after `+` (validated like a handle). */
export const ADDON_NAME_RE = HANDLE_RE;

/** A share's id, the part after the second `+` (docs/add-ons.md, Sharing). */
export const SHARE_ID_RE = /^[a-z0-9-]{1,30}$/;

/**
 * An add-on's address: `handle+name@host`, or one of its shares: `handle+name+share@host`
 * (docs/add-ons.md). The plain address is its owner's alone; a share's is for the people who
 * hold that share.
 */
export interface AddonAddress extends Address {
  name: string;
  /** The share (its id), for `handle+name+share@host`. */
  share?: string;
}

/**
 * Parses `handle+name@host` (an add-on on someone's account) and `handle+name+share@host` (one
 * of its shares). `parseAddress` never accepts either, so nothing that takes a person's address
 * (a knock, a connection, a public line) can reach an add-on by accident.
 */
export function parseAddonAddress(text: string): AddonAddress | undefined {
  const t = text.trim().toLowerCase().replace(/^@/, "");
  const at = t.lastIndexOf("@");
  if (at <= 0) return undefined;
  const parts = t.slice(0, at).split("+");
  const host = t.slice(at + 1);
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const [handle = "", name = "", share] = parts;
  if (!HANDLE_RE.test(handle) || !ADDON_NAME_RE.test(name) || !HOST_RE.test(host)) return undefined;
  if (share !== undefined && !SHARE_ID_RE.test(share)) return undefined;
  return share === undefined ? { handle, name, host } : { handle, name, share, host };
}

export const formatAddonAddress = (a: AddonAddress) =>
  `${a.handle}+${a.name}${a.share ? `+${a.share}` : ""}@${a.host}`;

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
