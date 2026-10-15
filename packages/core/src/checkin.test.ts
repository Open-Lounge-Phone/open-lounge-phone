import { describe, expect, it } from "vitest";
import { checkinStep, hhmm, localDay } from "./checkin.ts";

describe("the daily check-in", () => {
  it("alerts once the time passes without I'm OK, once a day", () => {
    expect(checkinStep("10:00", { minutes: 9 * 60, done: false, alerted: false })).toEqual({
      alert: false,
      nextInMin: 60,
    });
    expect(checkinStep("10:00", { minutes: 10 * 60, done: false, alerted: false })).toEqual({
      alert: true,
      nextInMin: 24 * 60,
    });
    // Pressed, or already told: nothing until tomorrow's time.
    expect(checkinStep("10:00", { minutes: 11 * 60, done: true, alerted: false })).toEqual({
      alert: false,
      nextInMin: 23 * 60,
    });
    expect(checkinStep("10:00", { minutes: 11 * 60, done: false, alerted: true }).alert).toBe(
      false,
    );
    expect(checkinStep("nope", { minutes: 0, done: false, alerted: false }).alert).toBe(false);
  });

  it("reads times and local days", () => {
    expect(hhmm("07:30")).toBe(450);
    expect(hhmm("24:00")).toBeUndefined();
    // 23:30 UTC is the next day in Amsterdam (UTC+2 in October).
    const t = new Date(Date.UTC(2026, 9, 13, 23, 30));
    expect(localDay(t, "UTC")).toBe("2026-10-13");
    expect(localDay(t, "Europe/Amsterdam")).toBe("2026-10-14");
  });
});
