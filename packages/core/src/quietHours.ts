/** 0 = Sunday ... 6 = Saturday, matching `Date#getDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A recurring quiet window in the household's local wall-clock time.
 *
 * `start`/`end` are "HH:MM" (24h). A window whose `end` is not after `start` runs past midnight
 * into the next day, so `days` names the day each window *starts* on ("Sun-Thu 21:00-07:00" is a
 * school-night bedtime). `start === end` means a full 24 hours.
 */
export interface QuietHoursRule {
  days: Weekday[];
  start: string;
  end: string;
}

export interface QuietHoursSchedule {
  /** IANA time zone, e.g. "America/New_York". */
  timeZone: string;
  rules: QuietHoursRule[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight for an "HH:MM" string. Throws on malformed input. */
export function parseHHMM(s: string): number {
  const m = HHMM.exec(s);
  if (!m) throw new Error(`invalid time "${s}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Throws with a readable message if the schedule cannot be evaluated. */
export function validateSchedule(schedule: QuietHoursSchedule): void {
  if (!isValidTimeZone(schedule.timeZone)) {
    throw new Error(`unknown time zone "${schedule.timeZone}"`);
  }
  for (const rule of schedule.rules) {
    parseHHMM(rule.start);
    parseHHMM(rule.end);
    for (const d of rule.days) {
      if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error(`invalid weekday ${d}`);
    }
  }
}

const WEEKDAYS: Record<string, Weekday> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Local weekday and minutes-since-midnight of `instant` in `timeZone`. */
export function localClock(instant: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, fmt);
  }
  let weekday: Weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of fmt.formatToParts(instant)) {
    if (part.type === "weekday") weekday = WEEKDAYS[part.value] ?? 0;
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** The UTC offset of `timeZone` at `instant`, in minutes (e.g. -240 for New York in summer). */
export function utcOffsetMinutes(instant: Date, timeZone: string): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatters.set(timeZone, fmt);
  }
  const name = fmt.formatToParts(instant).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!m) return 0; // "GMT": UTC itself
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

function ruleActive(rule: QuietHoursRule, weekday: Weekday, minutes: number): boolean {
  const start = parseHHMM(rule.start);
  const end = parseHHMM(rule.end);
  const today = rule.days.includes(weekday);
  if (start < end) return today && minutes >= start && minutes < end;
  // Spans midnight: the evening part belongs to today, the morning part to yesterday's window.
  const yesterday = rule.days.includes(((weekday + 6) % 7) as Weekday);
  return (today && minutes >= start) || (yesterday && minutes < end);
}

export function isQuietAt(schedule: QuietHoursSchedule, instant: Date): boolean {
  if (schedule.rules.length === 0) return false;
  const { weekday, minutes } = localClock(instant, schedule.timeZone);
  return schedule.rules.some((rule) => ruleActive(rule, weekday, minutes));
}

const MINUTE = 60_000;
const WEEK_MINUTES = 7 * 1440;
const SEARCH_LIMIT_MS = 8 * 24 * 60 * MINUTE;

/** Minutes-of-week (0 = Sunday 00:00) at which some rule starts or ends. */
function boundaries(schedule: QuietHoursSchedule): number[] {
  const out = new Set<number>();
  for (const rule of schedule.rules) {
    const start = parseHHMM(rule.start);
    const end = parseHHMM(rule.end);
    const length = end > start ? end - start : end - start + 1440;
    for (const d of rule.days) {
      out.add(d * 1440 + start);
      out.add((d * 1440 + start + length) % WEEK_MINUTES);
    }
  }
  return [...out];
}

/**
 * The next instant after `now` at which `isQuietAt` flips, or undefined if it never does
 * (no rules, or quiet around the clock). Lets servers sleep until quiet hours start or end
 * instead of polling. Handles DST by jumping to the next wall-clock boundary and then
 * binary-searching the exact minute.
 */
export function nextQuietChange(schedule: QuietHoursSchedule, now: Date): Date | undefined {
  const marks = boundaries(schedule);
  if (marks.length === 0) return undefined;
  const current = isQuietAt(schedule, now);
  const origin = Math.floor(now.getTime() / MINUTE) * MINUTE;
  let t = origin;
  while (t - origin <= SEARCH_LIMIT_MS) {
    const { weekday, minutes } = localClock(new Date(t), schedule.timeZone);
    const here = weekday * 1440 + minutes;
    const delta = Math.min(
      ...marks.map((m) => (m - here + WEEK_MINUTES) % WEEK_MINUTES || WEEK_MINUTES),
    );
    const next = t + delta * MINUTE;
    if (isQuietAt(schedule, new Date(next)) !== current) {
      // The flip lies in (t, next]; DST can move it off the wall-clock estimate.
      let lo = t;
      let hi = next;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
        if (isQuietAt(schedule, new Date(mid)) !== current) hi = mid;
        else lo = mid;
      }
      return new Date(hi);
    }
    t = next;
  }
  return undefined;
}
