import type { ConnectionView } from "./api.ts";

export interface ConnectionGroups {
  /** Knocks waiting for your answer. */
  requests: ConnectionView[];
  connected: ConnectionView[];
  /** Your knocks, waiting for theirs. */
  waiting: ConnectionView[];
  blocked: ConnectionView[];
}

/** Sorts connections into what the Connections screen shows, each list by name. */
export function groupConnections(list: ConnectionView[]): ConnectionGroups {
  const byName = (a: ConnectionView, b: ConnectionView) =>
    a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  const pick = (f: (c: ConnectionView) => boolean) => list.filter(f).sort(byName);
  return {
    requests: pick((c) => c.state === "requested" && c.direction === "in"),
    connected: pick((c) => c.state === "active"),
    waiting: pick((c) => c.state === "requested" && c.direction === "out"),
    blocked: pick((c) => c.state === "blocked"),
  };
}

/** "@host" for people on another server, "" for people on yours. */
export const hostBadge = (c: Pick<ConnectionView, "remote" | "host">): string =>
  c.remote ? `@${c.host}` : "";

/** Days until a pending knock lapses, for "expires in N days". */
export function daysLeft(expiresAt: number | null, now: number): number | undefined {
  if (expiresAt === null) return undefined;
  return Math.max(0, Math.ceil((expiresAt - now) / 86_400_000));
}
