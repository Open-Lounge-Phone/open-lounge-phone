import { describe, expect, it } from "vitest";
import { missedCountLine, missedWhen } from "./missed.ts";

describe("when a missed call was", () => {
  // Tuesday 2026-10-13 14:05 UTC.
  const at = Date.UTC(2026, 9, 13, 14, 5);
  it("today, yesterday, or the date, in the space's time", () => {
    expect(missedWhen(at, at + 60_000, 0)).toBe("14:05");
    expect(missedWhen(at, at + 24 * 3_600_000, 0)).toBe("YESTERDAY 14:05");
    expect(missedWhen(at, at + 3 * 24 * 3_600_000, 0)).toBe("13 OCT 14:05");
    // UTC+2: 16:05 local; at 23:00 UTC it's already the next day there.
    expect(missedWhen(at, at + 60_000, 120)).toBe("16:05");
    expect(missedWhen(at, Date.UTC(2026, 9, 13, 23, 0), 120)).toBe("YESTERDAY 16:05");
  });

  it("how many and when", () => {
    expect(missedCountLine({ kind: "call", count: 1 }, "14:05")).toBe("14:05");
    expect(missedCountLine({ kind: "call", count: 3 }, "14:05")).toBe("3 CALLS 14:05");
    expect(missedCountLine({ callback: true }, "14:05")).toBe("CALLED BACK 14:05");
  });
});
