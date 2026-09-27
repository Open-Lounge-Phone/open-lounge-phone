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
