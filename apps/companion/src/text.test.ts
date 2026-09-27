import { describe, expect, it } from "vitest";
import { endReasonText, formatBattery, formatDuration, formatLastSeen } from "./text.ts";

describe("text", () => {
  it("explains end reasons in plain words", () => {
    expect(endReasonText("denied")).toBe("Not allowed right now");
    expect(endReasonText("voicemail")).toBe("Quiet hours — voicemail coming soon");
    expect(endReasonText("unreachable")).toBe("Phone is offline");
    expect(endReasonText("timeout")).toBe("No answer");
    expect(endReasonText("busy")).toBe("Line is busy");
    expect(endReasonText(undefined)).toBe("Call ended");
  });

  it("formats battery", () => {
    expect(formatBattery({ pct: 14, charging: false })).toBe("14%");
    expect(formatBattery({ pct: 80, charging: true })).toBe("80% ⚡");
    expect(formatBattery(undefined)).toBe("");
  });

  it("formats last seen", () => {
    const now = 1_000_000_000;
    expect(formatLastSeen(null, now)).toBe("never");
    expect(formatLastSeen(now - 30_000, now)).toBe("just now");
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(formatLastSeen(now - 3 * 3_600_000, now)).toBe("3 h ago");
  });

  it("formats call durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(-5)).toBe("0:00");
  });
});
