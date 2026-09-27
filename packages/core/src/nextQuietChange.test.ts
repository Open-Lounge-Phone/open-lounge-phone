import { describe, expect, it } from "vitest";
import { isQuietAt, nextQuietChange, type QuietHoursSchedule } from "./quietHours.ts";

const MINUTE = 60_000;

/** Reference implementation: scan minute by minute. */
function bruteForce(schedule: QuietHoursSchedule, now: Date): Date | undefined {
  const current = isQuietAt(schedule, now);
  const origin = Math.floor(now.getTime() / MINUTE) * MINUTE;
  for (let t = origin + MINUTE; t <= origin + 8 * 1440 * MINUTE; t += MINUTE) {
    if (isQuietAt(schedule, new Date(t)) !== current) return new Date(t);
  }
  return undefined;
}

const bedtime = (timeZone: string): QuietHoursSchedule => ({
  timeZone,
  rules: [
    { days: [0, 1, 2, 3, 4], start: "21:00", end: "07:00" },
    { days: [1, 2, 3, 4, 5], start: "08:15", end: "15:00" },
  ],
});

describe("nextQuietChange", () => {
  it("is undefined without rules or when quiet around the clock", () => {
    const now = new Date("2026-03-02T12:00:00Z");
    expect(nextQuietChange({ timeZone: "UTC", rules: [] }, now)).toBeUndefined();
    const always: QuietHoursSchedule = {
      timeZone: "UTC",
      rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }],
    };
    expect(nextQuietChange(always, now)).toBeUndefined();
  });

  it("finds the next start and end", () => {
    const s = bedtime("UTC");
    // Monday 2026-03-02 12:00 UTC is inside school hours; they end at 15:00.
    expect(nextQuietChange(s, new Date("2026-03-02T12:00:00Z"))?.toISOString()).toBe(
      "2026-03-02T15:00:00.000Z",
    );
    expect(nextQuietChange(s, new Date("2026-03-02T15:00:00Z"))?.toISOString()).toBe(
      "2026-03-02T21:00:00.000Z",
    );
  });

  it("merges back-to-back windows into one quiet stretch", () => {
    const s: QuietHoursSchedule = {
      timeZone: "UTC",
      rules: [
        { days: [1], start: "20:00", end: "22:00" },
        { days: [1], start: "22:00", end: "23:00" },
      ],
    };
    expect(nextQuietChange(s, new Date("2026-03-02T20:30:00Z"))?.toISOString()).toBe(
      "2026-03-02T23:00:00.000Z",
    );
  });

  it.each([
    "America/New_York",
    "Europe/London",
    "Australia/Lord_Howe", // 30-minute DST shift
    "Asia/Kathmandu", // UTC+5:45
    "Pacific/Chatham", // UTC+12:45 / +13:45
  ])("matches a minute-by-minute scan in %s, including across DST", (tz) => {
    const s = bedtime(tz);
    // Sample instants around both DST transitions of the year and in between.
    const starts = [
      "2026-03-06T00:00:00Z",
      "2026-03-28T10:00:00Z",
      "2026-04-04T13:37:00Z",
      "2026-06-15T07:07:00Z",
      "2026-09-26T19:00:00Z",
      "2026-10-03T22:10:00Z",
      "2026-10-24T02:59:00Z",
      "2026-10-31T23:30:00Z",
    ];
    for (const iso of starts) {
      let now = new Date(iso);
      for (let step = 0; step < 6; step++) {
        const expected = bruteForce(s, now);
        expect(nextQuietChange(s, now)?.toISOString()).toBe(expected?.toISOString());
        if (!expected) break;
        now = new Date(expected.getTime() + 17 * 1000);
      }
    }
  });
});
