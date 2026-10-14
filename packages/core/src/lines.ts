// Public lines (docs/workplace.md "Public lines"): a team or org ring group published at its own
// address (`support@acme.example`) that people on other servers may call without connecting
// first. The one exception to knock-first, so it is off by default and every rule that decides
// who gets through lives here, pure, with tests. The server passes in what it looked up.

/** Who may call a public line. Kids' phones never may, whatever this says. */
export type LineWho =
  /** Anyone on a server that isn't blocked (here or by the space). */
  | "anyone"
  /** The space's members, and people with an active connection to one of them. */
  | "connections"
  /** Only the servers (`host`) and addresses (`handle@host`) on the line's allow-list. */
  | "allowlist";
export const LINE_WHO: readonly LineWho[] = ["anyone", "connections", "allowlist"];

/** What happens to a caller who waited the line's longest wait. */
export type MaxWaitAction =
  | { kind: "voicemail" }
  /** Ring another ring group of the space instead (its own rules; it never queues again). */
  | { kind: "group"; groupId: string }
  /** Ring a member instead. */
  | { kind: "user"; userId: string }
  /** End the call, with these words for the caller. */
  | { kind: "end"; message?: string };

/** A line's settings (stored with its ring group). */
export interface LineSettings {
  /** Published: callable from anywhere by its address. Off until an admin confirms it. */
  enabled: boolean;
  who: LineWho;
  /** `allowlist`: servers (`example.org`) and addresses (`ann@example.org`), lower case. */
  allow: string[];
  /** Callers wait in line when nobody is free (else the call goes to voicemail at once). */
  queue: boolean;
  /** Most callers waiting at once; one more goes to voicemail (or is turned away). */
  queueMax: number;
  /** Longest wait, in seconds, before `atMaxWait` happens. */
  queueWaitSeconds: number;
  /** Callers see (and phones show) their place in line. */
  showPosition: boolean;
  /** Callers may leave a voicemail instead of waiting, at any time. */
  offerVoicemail: boolean;
  atMaxWait: MaxWaitAction;
  /** Whether the line takes voicemail at all (its group's shared box). */
  voicemail: boolean;
  /** This line's own caps (calls per hour); null = the server's. Never above the server's. */
  callerPerHour: number | null;
  serverPerHour: number | null;
}

export const LINE_DEFAULTS: LineSettings = {
  enabled: false,
  who: "anyone",
  allow: [],
  queue: true,
  queueMax: 10,
  queueWaitSeconds: 600,
  showPosition: true,
  offerVoicemail: true,
  atMaxWait: { kind: "voicemail" },
  voicemail: true,
  callerPerHour: null,
  serverPerHour: null,
};

export const LINE_QUEUE_MAX = 50;
export const LINE_WAIT_MIN_SECONDS = 30;
export const LINE_WAIT_MAX_SECONDS = 3600;
export const LINE_ALLOW_MAX = 100;

/** What the server knows about someone calling a line. */
export interface LineCaller {
  /** Their verified address, `handle@host` (lower case). */
  address: string;
  /** Their server (lower case); this server's own host for people here. */
  host: string;
  /** A kids' phone is calling (here, or flagged by the caller's server). */
  kidsPhone: boolean;
  /** A member of the line's space. */
  member: boolean;
  /** An active connection with a member of the line's space. */
  connected: boolean;
}

/** The space's blocklist for its public lines (lower case). */
export interface LineBlocks {
  addresses: ReadonlySet<string>;
  servers: ReadonlySet<string>;
}

export type LineRefusal = "disabled" | "kids" | "blocked" | "not_allowed";

/**
 * Whether a caller gets through to a line at all. Every refusal looks the same to the caller
 * (as if the line were unavailable), so nobody can tell a blocked address from a missing line.
 */
export function lineAdmits(
  line: Pick<LineSettings, "enabled" | "who" | "allow">,
  caller: LineCaller,
  blocks: LineBlocks,
): { ok: true } | { ok: false; why: LineRefusal } {
  if (!line.enabled) return { ok: false, why: "disabled" };
  if (caller.kidsPhone) return { ok: false, why: "kids" };
  const address = caller.address.toLowerCase();
  const host = caller.host.toLowerCase();
  if (!caller.member && (blocks.addresses.has(address) || blocks.servers.has(host))) {
    return { ok: false, why: "blocked" };
  }
  if (caller.member || line.who === "anyone") return { ok: true };
  if (line.who === "connections") {
    return caller.connected ? { ok: true } : { ok: false, why: "not_allowed" };
  }
  const allowed = line.allow.some((a) => a.toLowerCase() === address || a.toLowerCase() === host);
  return allowed ? { ok: true } : { ok: false, why: "not_allowed" };
}

/** A line's cap: its own if it set one, never looser than the server's. */
export function effectiveLimit(server: number, line: number | null): number {
  return line === null ? server : Math.min(server, line);
}

/** One caller waiting for a line, as kept by the hub. */
export interface QueueEntry {
  callId: string;
  /** When they joined the line (the first time; a retry that wasn't answered keeps it). */
  since: number;
}

/** The line in order: whoever came first goes first (ties by call id, so it's stable). */
export function queueOrder<E extends QueueEntry>(entries: readonly E[]): E[] {
  return [...entries].sort((a, b) => a.since - b.since || (a.callId < b.callId ? -1 : 1));
}

/** Each waiting call's place (1 = next), and how many wait. */
export function queuePositions(
  entries: readonly QueueEntry[],
): Map<string, { position: number; size: number }> {
  const ordered = queueOrder(entries);
  return new Map(ordered.map((e, i) => [e.callId, { position: i + 1, size: ordered.length }]));
}

/**
 * What happens to a call nobody can take right now: wait in line, or not. `waiting` = how many
 * already wait (not counting this call).
 */
export function queueAdmit(
  line: Pick<LineSettings, "queue" | "queueMax">,
  waiting: number,
): "queue" | "full" | "off" {
  if (!line.queue) return "off";
  return waiting < line.queueMax ? "queue" : "full";
}

/**
 * What a caller who can't wait (queue off or full) gets: voicemail if the line takes it, else
 * the call simply ends as unavailable.
 */
export function noQueueOutcome(line: Pick<LineSettings, "voicemail">): "voicemail" | "end" {
  return line.voicemail ? "voicemail" : "end";
}

/** What the line's longest wait does, given whether it takes voicemail at all. */
export function maxWaitOutcome(
  line: Pick<LineSettings, "atMaxWait" | "voicemail">,
  selfGroupId: string,
): MaxWaitAction {
  const a = line.atMaxWait;
  if (a.kind === "voicemail") return line.voicemail ? a : { kind: "end" };
  if (a.kind === "group" && a.groupId === selfGroupId) {
    return line.voicemail ? { kind: "voicemail" } : { kind: "end" };
  }
  return a;
}

/** Whether a waiting caller may choose voicemail instead of waiting on. */
export function mayLeaveVoicemailInstead(
  line: Pick<LineSettings, "voicemail" | "offerVoicemail">,
): boolean {
  return line.voicemail && line.offerVoicemail;
}

/** The note a caller sees when the line ends their wait without voicemail. */
export const LINE_ENDED_NOTE = "Nobody could take your call. Please try again later.";

/** A queue position in words ("2nd"), for "You're 2nd in line". */
export function ordinal(n: number): string {
  const teens = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teens ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

const HANDLE = /^[a-z0-9._-]{2,30}$/;
const HOST =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/** An allow-list or blocklist entry: a server `host` or an address `handle@host`, lower case. */
export function lineEntry(raw: string): { kind: "server" | "address"; value: string } | undefined {
  const v = raw.trim().toLowerCase().replace(/^@/, "");
  const at = v.lastIndexOf("@");
  if (at < 0) return HOST.test(v) ? { kind: "server", value: v } : undefined;
  const ok = HANDLE.test(v.slice(0, at)) && HOST.test(v.slice(at + 1));
  return ok ? { kind: "address", value: v } : undefined;
}
