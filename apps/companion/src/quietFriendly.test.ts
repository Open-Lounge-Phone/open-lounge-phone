import { describe, expect, it } from "vitest";
import { formatTime, friendlyRule, weekSegments, whenText } from "./quiet.ts";
import { quietStatus } from "./quietStatus.ts";

const NY = "America/New_York";

describe("friendly quiet-hours text", () => {
  it("formats times in the locale's style only", () => {
    expect(formatTime("22:30", "en-US")).toBe("10:30 PM");
    expect(formatTime("09:00", "en-US")).toBe("9:00 AM");
    expect(formatTime("22:30", "en-GB")).toBe("22:30");
  });

  it("describes rules in plain language", () => {
    const every = [0, 1, 2, 3, 4, 5, 6];
    expect(friendlyRule({ days: every, start: "22:30", end: "09:00" }, "en-US")).toBe(
      "Every day · 10:30 PM → 9:00 AM next morning",
    );
    expect(friendlyRule({ days: [1, 2, 3, 4, 5], start: "08:00", end: "15:00" }, "en-US")).toBe(
      "Mon–Fri · 8:00 AM → 3:00 PM",
    );
    expect(friendlyRule({ days: [0], start: "06:00", end: "06:00" }, "en-US")).toBe(
      "Sun · all day from 6:00 AM",
    );
  });

  it("says when relative to now in the household's time zone", () => {
    // Monday 2026-03-02 15:00 EST.
    const now = new Date("2026-03-02T20:00:00Z");
    expect(whenText(new Date("2026-03-03T03:30:00Z"), now, NY, "en-US")).toBe(
      "tonight at 10:30 PM",
    );
    expect(whenText(new Date("2026-03-02T21:00:00Z"), now, NY, "en-US")).toBe("today at 4:00 PM");
    expect(whenText(new Date("2026-03-03T14:00:00Z"), now, NY, "en-US")).toBe(
      "tomorrow at 9:00 AM",
    );
    expect(whenText(new Date("2026-03-05T14:00:00Z"), now, NY, "en-US")).toBe(
      "Thursday at 9:00 AM",
    );
  });
});

describe("weekSegments", () => {
  it("splits past-midnight windows across days and wraps Saturday to Sunday", () => {
    const week = weekSegments([{ days: [6], start: "22:00", end: "07:00" }]);
    expect(week[6]).toEqual([{ from: 1320, to: 1440 }]);
    expect(week[0]).toEqual([{ from: 0, to: 420 }]);
    expect(week[1]).toEqual([]);
  });

  it("merges overlapping windows and ignores invalid rules", () => {
    const week = weekSegments([
      { days: [1], start: "20:00", end: "22:00" },
      { days: [1], start: "21:00", end: "23:00" },
      { days: [], start: "01:00", end: "02:00" },
    ]);
    expect(week[1]).toEqual([{ from: 1200, to: 1380 }]);
  });

  it("treats start === end as a full 24 hours from the start", () => {
    const week = weekSegments([{ days: [2], start: "06:00", end: "06:00" }]);
    expect(week[2]).toEqual([{ from: 360, to: 1440 }]);
    expect(week[3]).toEqual([{ from: 0, to: 360 }]);
  });
});

describe("quietStatus", () => {
  const schedule = {
    timeZone: NY,
    rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "22:30", end: "09:00" }],
  };

  it("says when quiet ends while quiet", () => {
    const now = new Date("2026-03-03T04:00:00Z"); // Mon 11 PM EST
    expect(quietStatus(schedule, now, "en-US")).toEqual({
      quiet: true,
      text: "Quiet now — phones stay silent until tomorrow at 9:00 AM.",
    });
  });

  it("says when quiet starts next", () => {
    const now = new Date("2026-03-02T20:00:00Z"); // Mon 3 PM EST
    expect(quietStatus(schedule, now, "en-US")).toEqual({
      quiet: false,
      text: "Not quiet right now — next quiet time starts tonight at 10:30 PM.",
    });
  });

  it("handles no rules", () => {
    expect(quietStatus({ timeZone: NY, rules: [] }, new Date()).text).toMatch(/No quiet hours/);
  });
});
