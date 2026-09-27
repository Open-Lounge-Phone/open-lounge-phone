import { describe, expect, it } from "vitest";
import {
  isQuietAt,
  localClock,
  parseHHMM,
  type QuietHoursSchedule,
  validateSchedule,
  type Weekday,
} from "./quietHours.ts";

const NY = "America/New_York";
const SCHOOL_NIGHTS = [0, 1, 2, 3, 4] as const; // Sun-Thu

const bedtime: QuietHoursSchedule = {
  timeZone: NY,
  rules: [{ days: [...SCHOOL_NIGHTS], start: "21:00", end: "07:00" }],
};

const school: QuietHoursSchedule = {
  timeZone: NY,
  rules: [{ days: [1, 2, 3, 4, 5], start: "08:00", end: "15:00" }],
};

// 2026-03-02 is a Monday. EST is UTC-5 until 2026-03-08, EDT (UTC-4) after.
const utc = (iso: string) => new Date(`${iso}Z`);

describe("parseHHMM", () => {
  it("parses valid times", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("07:30")).toBe(450);
    expect(parseHHMM("23:59")).toBe(1439);
  });
  it.each(["24:00", "7:30", "07:60", "0730", ""])("rejects %j", (s) => {
    expect(() => parseHHMM(s)).toThrow();
  });
});

describe("localClock", () => {
  it("converts to local wall time", () => {
    expect(localClock(utc("2026-03-03T02:30:00"), NY)).toEqual({
      weekday: 1,
      minutes: 21 * 60 + 30,
    });
  });
  it("reports midnight as 0, not 24", () => {
    expect(localClock(utc("2026-03-03T05:00:00"), NY)).toEqual({ weekday: 2, minutes: 0 });
  });
});

describe("isQuietAt", () => {
  it("is never quiet with no rules", () => {
    expect(isQuietAt({ timeZone: NY, rules: [] }, new Date())).toBe(false);
  });

  it("handles same-day windows with inclusive start, exclusive end", () => {
    expect(isQuietAt(school, utc("2026-03-02T12:59:00"))).toBe(false); // Mon 07:59
    expect(isQuietAt(school, utc("2026-03-02T13:00:00"))).toBe(true); // Mon 08:00
    expect(isQuietAt(school, utc("2026-03-02T19:59:00"))).toBe(true); // Mon 14:59
    expect(isQuietAt(school, utc("2026-03-02T20:00:00"))).toBe(false); // Mon 15:00
    expect(isQuietAt(school, utc("2026-03-07T15:00:00"))).toBe(false); // Sat 10:00
  });

  it("carries a midnight-spanning window into the next morning", () => {
    expect(isQuietAt(bedtime, utc("2026-03-03T01:59:00"))).toBe(false); // Mon 20:59
    expect(isQuietAt(bedtime, utc("2026-03-03T02:00:00"))).toBe(true); // Mon 21:00
    expect(isQuietAt(bedtime, utc("2026-03-03T05:00:00"))).toBe(true); // Tue 00:00
    expect(isQuietAt(bedtime, utc("2026-03-03T11:59:00"))).toBe(true); // Tue 06:59
    expect(isQuietAt(bedtime, utc("2026-03-03T12:00:00"))).toBe(false); // Tue 07:00
  });

  it("uses the day the window starts on", () => {
    // Thursday night is a school night, so Friday early morning is quiet...
    expect(isQuietAt(bedtime, utc("2026-03-06T08:00:00"))).toBe(true); // Fri 03:00
    // ...but Friday night is not, so Saturday early morning is not.
    expect(isQuietAt(bedtime, utc("2026-03-07T03:00:00"))).toBe(false); // Fri 22:00
    expect(isQuietAt(bedtime, utc("2026-03-07T08:00:00"))).toBe(false); // Sat 03:00
    // Sunday night is a school night; Sunday early morning belongs to Saturday's (absent) window.
    expect(isQuietAt(bedtime, utc("2026-03-08T08:00:00"))).toBe(false); // Sun 04:00 EDT
    expect(isQuietAt(bedtime, utc("2026-03-09T02:00:00"))).toBe(true); // Sun 22:00 EDT
  });

  it("follows wall-clock time across DST changes", () => {
    // Spring forward: 2026-03-08. 21:00 EDT is 01:00 UTC the next day.
    expect(isQuietAt(bedtime, utc("2026-03-09T00:59:00"))).toBe(false); // Sun 20:59 EDT
    expect(isQuietAt(bedtime, utc("2026-03-09T01:00:00"))).toBe(true); // Sun 21:00 EDT
    // Fall back: 2026-11-01 (Sun). Window ends 07:00 EST = 12:00 UTC on Mon 11-02.
    expect(isQuietAt(bedtime, utc("2026-11-02T11:59:00"))).toBe(true); // Mon 06:59 EST
    expect(isQuietAt(bedtime, utc("2026-11-02T12:00:00"))).toBe(false); // Mon 07:00 EST
  });

  it("treats start === end as a full 24 hours from start", () => {
    const sunday: QuietHoursSchedule = {
      timeZone: "UTC",
      rules: [{ days: [0], start: "06:00", end: "06:00" }],
    };
    expect(isQuietAt(sunday, utc("2026-03-01T05:59:00"))).toBe(false); // Sun 05:59
    expect(isQuietAt(sunday, utc("2026-03-01T06:00:00"))).toBe(true); // Sun 06:00
    expect(isQuietAt(sunday, utc("2026-03-02T05:59:00"))).toBe(true); // Mon 05:59
    expect(isQuietAt(sunday, utc("2026-03-02T06:00:00"))).toBe(false); // Mon 06:00
  });

  it("combines multiple rules", () => {
    const both = { timeZone: NY, rules: [...bedtime.rules, ...school.rules] };
    expect(isQuietAt(both, utc("2026-03-02T15:00:00"))).toBe(true); // Mon 10:00 school
    expect(isQuietAt(both, utc("2026-03-03T03:00:00"))).toBe(true); // Mon 22:00 bedtime
    expect(isQuietAt(both, utc("2026-03-02T22:00:00"))).toBe(false); // Mon 17:00
  });
});

describe("validateSchedule", () => {
  it("accepts a good schedule", () => {
    expect(() => validateSchedule(bedtime)).not.toThrow();
  });
  it("rejects unknown time zones", () => {
    expect(() => validateSchedule({ timeZone: "Mars/Olympus", rules: [] })).toThrow(/time zone/);
  });
  it("rejects bad times and weekdays", () => {
    expect(() =>
      validateSchedule({ timeZone: NY, rules: [{ days: [1], start: "25:00", end: "07:00" }] }),
    ).toThrow();
    expect(() =>
      validateSchedule({
        timeZone: NY,
        rules: [{ days: [7 as Weekday], start: "21:00", end: "07:00" }],
      }),
    ).toThrow(/weekday/);
  });
});
