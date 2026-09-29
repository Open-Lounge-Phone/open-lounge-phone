import { describe, expect, it } from "vitest";
import { loungeDayEnd } from "./lounge.ts";

describe("loungeDayEnd", () => {
  it("is the next local day end after the session started", () => {
    // 2026-03-02 12:00 UTC.
    const noon = Date.UTC(2026, 2, 2, 12);
    expect(loungeDayEnd(noon, "18:00", "UTC")).toBe(Date.UTC(2026, 2, 2, 18));
    expect(loungeDayEnd(noon, "00:00", "UTC")).toBe(Date.UTC(2026, 2, 3, 0));
    // Started after today's day end: tomorrow's.
    expect(loungeDayEnd(Date.UTC(2026, 2, 2, 19), "18:00", "UTC")).toBe(Date.UTC(2026, 2, 3, 18));
    // Started exactly at the day end: the next one.
    expect(loungeDayEnd(Date.UTC(2026, 2, 2, 18), "18:00", "UTC")).toBe(Date.UTC(2026, 2, 3, 18));
  });

  it("uses the space's time zone, across a DST change", () => {
    // New York, 17:00 local on 2026-03-07 (EST, UTC-5) → 18:00 local = 23:00 UTC.
    expect(loungeDayEnd(Date.UTC(2026, 2, 7, 22), "18:00", "America/New_York")).toBe(
      Date.UTC(2026, 2, 7, 23),
    );
    // Sunday 2026-03-08 clocks go forward: 18:00 EDT = 22:00 UTC.
    expect(loungeDayEnd(Date.UTC(2026, 2, 8, 12), "18:00", "America/New_York")).toBe(
      Date.UTC(2026, 2, 8, 22),
    );
    // 02:30 doesn't exist that Sunday in New York: the next day's 02:30 EDT (06:30 UTC).
    expect(loungeDayEnd(Date.UTC(2026, 2, 8, 5), "02:30", "America/New_York")).toBe(
      Date.UTC(2026, 2, 9, 6, 30),
    );
  });
});
