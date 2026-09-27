import { describe, expect, it } from "vitest";
import { describeDays, describeRule, spansMidnight, toggleDay, validateRule } from "./quiet.ts";

describe("quiet hours helpers", () => {
  it("validates rules", () => {
    expect(validateRule({ days: [1], start: "21:00", end: "07:00" })).toBeUndefined();
    expect(validateRule({ days: [], start: "21:00", end: "07:00" })).toMatch(/day/);
    expect(validateRule({ days: [1], start: "9:00", end: "07:00" })).toMatch(/Start/);
    expect(validateRule({ days: [1], start: "21:00", end: "24:00" })).toMatch(/End/);
    expect(validateRule({ days: [7], start: "21:00", end: "07:00" })).toMatch(/day/);
  });

  it("detects windows that run past midnight", () => {
    expect(spansMidnight({ days: [0], start: "21:00", end: "07:00" })).toBe(true);
    expect(spansMidnight({ days: [0], start: "08:00", end: "15:00" })).toBe(false);
    expect(spansMidnight({ days: [0], start: "06:00", end: "06:00" })).toBe(true);
  });

  it("describes day sets compactly", () => {
    expect(describeDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(describeDays([0, 1, 2, 3, 4])).toBe("Sun–Thu");
    expect(describeDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(describeDays([5, 6])).toBe("Fri, Sat");
    expect(describeDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(describeDays([3, 1, 2, 2])).toBe("Mon–Wed");
  });

  it("describes rules", () => {
    expect(describeRule({ days: [0, 1, 2, 3, 4], start: "21:00", end: "07:00" })).toBe(
      "Sun–Thu 21:00–07:00 (next day)",
    );
    expect(describeRule({ days: [1, 2, 3, 4, 5], start: "08:00", end: "15:00" })).toBe(
      "Mon–Fri 08:00–15:00",
    );
    expect(describeRule({ days: [0], start: "06:00", end: "06:00" })).toBe(
      "Sun, all day from 06:00",
    );
  });

  it("toggles days keeping them sorted", () => {
    expect(toggleDay([1, 3], 2)).toEqual([1, 2, 3]);
    expect(toggleDay([1, 2, 3], 2)).toEqual([1, 3]);
  });
});
