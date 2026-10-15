// The daily check-in (docs/phone-ux.md "Daily check-in"): someone presses I'm OK on the phone by
// a local time each day; if nobody has, the space's guardians are told, once that day. Pure: the
// server passes in the local day and time (the space's time zone).

const DAY_MIN = 24 * 60;

/** `HH:MM` → minutes since midnight, or undefined. */
export function hhmm(s: string): number | undefined {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/** The local calendar day (`YYYY-MM-DD`) at `instant` in `timeZone`. */
export function localDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export interface CheckinNow {
  /** Local minutes since midnight now. */
  minutes: number;
  /** Someone pressed I'm OK today. */
  done: boolean;
  /** Today's alert went out already. */
  alerted: boolean;
}

/**
 * Whether to tell the guardians now (the time passed today, nobody pressed I'm OK, no alert yet),
 * and in how many minutes to look again (the next time it could be due).
 */
export function checkinStep(by: string, now: CheckinNow): { alert: boolean; nextInMin: number } {
  const at = hhmm(by);
  if (at === undefined) return { alert: false, nextInMin: DAY_MIN };
  const settled = now.done || now.alerted;
  if (!settled && now.minutes >= at) return { alert: true, nextInMin: DAY_MIN - now.minutes + at };
  if (!settled) return { alert: false, nextInMin: at - now.minutes };
  // Today is settled: tomorrow's time.
  return { alert: false, nextInMin: DAY_MIN - now.minutes + at };
}
