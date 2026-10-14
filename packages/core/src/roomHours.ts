// Party line hours: a room may be open only in weekly windows (the space's time zone, the same
// rules and code as quiet hours). At opening its members' phones and apps are told once; a
// minute before closing everyone in it is warned (the idle warning, `closing`); at closing it
// ends. Pure: the hub passes `now` and what it stored.
import {
  isQuietAt,
  localClock,
  nextQuietChange,
  type QuietHoursRule,
  type Weekday,
} from "./quietHours.ts";

/** A minute's warning before a room closes (the same grace as the idle rule). */
export const ROOM_CLOSING_WARNING_MS = 60_000;

export interface RoomHours {
  timeZone: string;
  rules: { days: number[]; start: string; end: string }[];
}

const schedule = (h: RoomHours) => ({
  timeZone: h.timeZone,
  rules: h.rules.map((r) => ({ ...r, days: r.days as Weekday[] }) as QuietHoursRule),
});

/** Whether a room is open at `now`, and when that next changes (none: always open). */
export function roomOpenAt(
  hours: RoomHours | undefined,
  now: number,
): { open: boolean; until?: number } {
  if (!hours?.rules.length) return { open: true };
  const s = schedule(hours);
  const open = isQuietAt(s, new Date(now));
  const next = nextQuietChange(s, new Date(now));
  return { open, ...(next ? { until: next.getTime() } : {}) };
}

/** What the hub does for a scheduled room at `now`. */
export interface RoomHoursStep {
  /** It just opened: tell its members (once per window), closing at `closesAt`. */
  announce?: { closesAt: number };
  /** It closes soon: warn the people in it (once per window). */
  warn?: { closesAt: number };
  /** It's closed: end it for the people still in. */
  close?: boolean;
  /** When to look again. */
  next?: number;
}

export function roomHoursStep(
  hours: RoomHours | undefined,
  now: number,
  state: {
    /** The end of the window whose opening was announced (stored). */
    announcedUntil: number | null;
    /** The closing the people in it were warned of. */
    warnedFor?: number;
    /** Anyone in the room now. */
    occupied: boolean;
  },
): RoomHoursStep {
  if (!hours?.rules.length) return {};
  const { open, until } = roomOpenAt(hours, now);
  if (!open)
    return { ...(state.occupied ? { close: true } : {}), ...(until ? { next: until } : {}) };
  const out: RoomHoursStep = {};
  if (until !== undefined) {
    if (state.announcedUntil === null || state.announcedUntil <= now) {
      out.announce = { closesAt: until };
    }
    const warnAt = until - ROOM_CLOSING_WARNING_MS;
    if (now >= warnAt && state.occupied && state.warnedFor !== until) {
      out.warn = { closesAt: until };
    }
    out.next = now < warnAt ? warnAt : until;
  }
  return out;
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Opens Fri 19:00" for a closed room (or undefined when it never opens). */
export function opensText(hours: RoomHours | undefined, now: number): string | undefined {
  const { open, until } = roomOpenAt(hours, now);
  if (open || until === undefined || !hours) return undefined;
  const { weekday, minutes } = localClock(new Date(until), hours.timeZone);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `Opens ${DAY[weekday]} ${hh}:${mm}`;
}
