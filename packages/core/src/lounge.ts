import { isQuietAt, nextQuietChange, parseHHMM, type Weekday } from "./quietHours.ts";

const EVERY_DAY: Weekday[] = [0, 1, 2, 3, 4, 5, 6];

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The first local `dayEnd` ("HH:MM") after `since` in `timeZone`: when a Lounge session that
 * started at `since` ends under the space's "end of day" policy. DST-safe: a day end that falls in
 * a skipped hour moves to the next day that has it. Pure.
 */
export function loungeDayEnd(since: number, dayEnd: string, timeZone: string): number {
  const start = parseHHMM(dayEnd);
  // A one-minute "window" at the day end; its start is the instant we want.
  const schedule = {
    timeZone,
    rules: [{ days: EVERY_DAY, start: dayEnd, end: hhmm((start + 1) % 1440) }],
  };
  let t = new Date(since);
  for (let i = 0; i < 4; i++) {
    const next = nextQuietChange(schedule, t);
    if (!next) break;
    if (isQuietAt(schedule, next)) return next.getTime();
    t = next;
  }
  // Unreachable for a valid time zone; fall back to a day later.
  return since + 24 * 60 * 60 * 1000;
}
