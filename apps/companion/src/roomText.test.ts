import { describe, expect, it } from "vitest";
import { idleSecondsLeft, roomKindText, roomPrivacyText, whoIsIn } from "./roomText.ts";

describe("room words", () => {
  it("is honest about relayed rooms", () => {
    expect(roomPrivacyText("mesh")).toMatch(/end-to-end encrypted/);
    for (const media of ["sfu", "livekit"] as const) {
      const text = roomPrivacyText(media);
      expect(text).toMatch(/not end to end/);
      expect(text).toMatch(/SFrame/);
    }
  });

  it("says who's in", () => {
    expect(whoIsIn([])).toBe("Nobody's in");
    expect(whoIsIn(["Mom"])).toBe("Mom is in");
    expect(whoIsIn(["Mom", "Dad", "Kid"])).toBe("Mom, Dad and Kid are in");
    expect(whoIsIn(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others are in");
  });

  it("counts down the idle warning and names kinds", () => {
    expect(idleSecondsLeft(61_000, 1_000)).toBe(60);
    expect(idleSecondsLeft(1_000, 5_000)).toBe(0);
    expect(roomKindText("party")).toBe("Party line");
    expect(roomKindText("call")).toBe("3-way call");
  });
});
