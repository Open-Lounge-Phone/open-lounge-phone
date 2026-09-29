// Rooms (party lines, phone rooms, 3-way calls): the rules that decide who gets in, whose audio
// a relay forwards, and when a silent participant is dropped. Pure: the hub passes `now` in.

/** A room without a relay is a peer-to-peer mesh, and a mesh holds at most this many people. */
export const MESH_MAX = 4;
/** A relay forwards everyone's audio up to this room size… */
export const FORWARD_ALL_UP_TO = 4;
/** …and above it only this many active speakers (cost control, see docs/hub.md). */
export const TOP_SPEAKERS = 3;
/** Largest room, with a relay. */
export const ROOM_MAX = 20;
/** Silence plus no interaction for this long earns a warning (`room.idle`)… */
export const ROOM_IDLE_MS = 10 * 60_000;
/** …and a drop this long after the warning, unless they speak or interact. */
export const ROOM_IDLE_GRACE_MS = 60_000;

export interface Speaker {
  id: string;
  speaking: boolean;
  /** When they last started or stopped speaking (0 = never spoke). */
  lastSpokeAt: number;
  muted: boolean;
}

/** Most relevant first: speaking now, then whoever spoke most recently, then join order. */
function rank(list: Speaker[]): Speaker[] {
  return list
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        Number(b.s.speaking) - Number(a.s.speaking) ||
        b.s.lastSpokeAt - a.s.lastSpokeAt ||
        a.i - b.i,
    )
    .map((x) => x.s);
}

/**
 * Whose audio the relay sends to `recipient`. In rooms of up to FORWARD_ALL_UP_TO people:
 * everyone else who isn't muted. In bigger rooms: at most `max` of them, the active speakers.
 * `current` is what the recipient gets now; it's kept where possible so the relay doesn't
 * reshuffle on every pause — a forwarded person is only replaced by someone speaking while they
 * aren't, and then the one who spoke longest ago goes.
 */
export function forwardFor(
  recipient: string,
  participants: Speaker[],
  current: readonly string[],
  max = TOP_SPEAKERS,
): string[] {
  const others = participants.filter((p) => p.id !== recipient && !p.muted);
  if (participants.length <= FORWARD_ALL_UP_TO) return others.map((p) => p.id);
  const ranked = rank(others);
  const pos = new Map(ranked.map((p, i) => [p.id, i]));
  let chosen = ranked.filter((p) => current.includes(p.id));
  if (chosen.length > max) chosen = chosen.slice(0, max);
  for (const candidate of ranked) {
    if (chosen.includes(candidate)) continue;
    if (chosen.length < max) {
      chosen.push(candidate);
      continue;
    }
    if (!candidate.speaking) break; // ranked: nobody further down is speaking either
    const quiet = chosen.filter((c) => !c.speaking);
    if (quiet.length === 0) break;
    const victim = quiet.reduce((a, b) => (a.lastSpokeAt <= b.lastSpokeAt ? a : b));
    chosen = chosen.map((c) => (c === victim ? candidate : c));
  }
  return chosen
    .sort((a, b) => (pos.get(a.id) as number) - (pos.get(b.id) as number))
    .map((p) => p.id);
}

export interface Activity {
  /** Last time they spoke or interacted (joined, unmuted, `room.here`, a key press). */
  lastActive: number;
  /** When they were warned (`room.idle`), if they were and haven't been active since. */
  warnedAt?: number;
}

export type IdleVerdict =
  /** Nothing to do before `next`. */
  { action: "none"; next: number } | { action: "warn"; dropAt: number } | { action: "drop" };

/**
 * The idle rule: 10 minutes of silence and no interaction → a warning; still nothing a minute
 * later → dropped. Speaking or interacting after the warning starts over.
 */
export function idleCheck(a: Activity, now: number): IdleVerdict {
  const warned = a.warnedAt !== undefined && a.warnedAt >= a.lastActive ? a.warnedAt : undefined;
  if (warned === undefined) {
    const due = a.lastActive + ROOM_IDLE_MS;
    return now >= due
      ? { action: "warn", dropAt: now + ROOM_IDLE_GRACE_MS }
      : { action: "none", next: due };
  }
  const dropAt = warned + ROOM_IDLE_GRACE_MS;
  return now >= dropAt ? { action: "drop" } : { action: "none", next: dropAt };
}

export type RoomKind = "party" | "phone" | "call";

export interface RoomPolicy {
  kind: RoomKind;
  /** `space`: members of the room's space only; `connections`: also its owner's connections. */
  access: "space" | "connections";
  locked: boolean;
  /** People in it now. */
  size: number;
  /** MESH_MAX without a relay, ROOM_MAX with one. */
  max: number;
}

/** Who wants in, as the room's own server sees them. */
export interface Joiner {
  /** A member of the room's space (their app, their own phone, a Lounge phone they're at). */
  inSpace: boolean;
  /** Has an active connection with the room's owner (someone in another space or server). */
  connected: boolean;
  /** A kids' phone: it may join only rooms of its own space that a guardian put on its list. */
  kidsPhone?: { allowListed: boolean };
}

export type RoomDecision = { ok: true } | { ok: false; reason: "denied" | "locked" | "full" };

/**
 * Default deny. A 3-way call's room is joined only by merging, never by dialing it. Kids' phones
 * need their space and their allow-list. Everyone else needs the space, or — when the room is
 * open to connections — an active connection with its owner. Then: not locked, not full.
 */
export function roomAccess(room: RoomPolicy, who: Joiner): RoomDecision {
  if (room.kind === "call") return { ok: false, reason: "denied" };
  let allowed: boolean;
  if (who.kidsPhone) allowed = who.inSpace && who.kidsPhone.allowListed;
  else allowed = who.inSpace || (room.access === "connections" && who.connected);
  if (!allowed) return { ok: false, reason: "denied" };
  if (room.locked) return { ok: false, reason: "locked" };
  if (room.size >= room.max) return { ok: false, reason: "full" };
  return { ok: true };
}

/** One party of a merge or an attended transfer, for `mayConnect`. */
export interface Meeting {
  /** Party key (`usr:<id>`, `dev:<id>`, `fed:…`). */
  key: string;
  /** A kids' phone: the party keys on its allow-list. */
  kidsPhone?: { allowed: ReadonlySet<string> };
}

/**
 * Merging calls or connecting two people by transfer must not let a kids' phone talk to someone
 * its guardians didn't allow: every other party must be on each kids' phone's allow-list.
 */
export function mayConnect(parties: readonly Meeting[]): boolean {
  for (const p of parties) {
    if (!p.kidsPhone) continue;
    for (const other of parties) {
      if (other !== p && !p.kidsPhone.allowed.has(other.key)) return false;
    }
  }
  return true;
}
