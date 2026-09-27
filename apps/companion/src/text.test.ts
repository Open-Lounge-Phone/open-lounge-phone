import { describe, expect, it } from "vitest";
import {
  endReasonText,
  formatBattery,
  formatDuration,
  formatLastSeen,
  formatWhen,
  powerWarning,
  transcriptText,
} from "./text.ts";

describe("text", () => {
  it("explains end reasons in plain words", () => {
    expect(endReasonText("denied")).toBe("Not allowed right now");
    expect(endReasonText("voicemail")).toBe("It's quiet hours");
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

describe("voicemail text", () => {
  it("describes transcript states", () => {
    expect(transcriptText("pending", null)).toBe("Transcribing…");
    expect(transcriptText("done", "  hi there ")).toBe("hi there");
    expect(transcriptText("done", "")).toBe("(no words detected)");
    expect(transcriptText("failed", null)).toBe("Couldn't transcribe this message");
    expect(transcriptText("unavailable", null)).toBe("No transcript");
  });

  it("says today, yesterday, or the date", () => {
    const now = new Date(2026, 8, 27, 20, 0).getTime();
    expect(formatWhen(new Date(2026, 8, 27, 7, 42).getTime(), now, "en-US")).toBe("Today 7:42 AM");
    expect(formatWhen(new Date(2026, 8, 26, 23, 5).getTime(), now, "en-US")).toBe(
      "Yesterday 11:05 PM",
    );
    expect(formatWhen(new Date(2026, 8, 20, 9, 0).getTime(), now, "en-US")).toBe("Sep 20 9:00 AM");
  });
});

describe("powerWarning", () => {
  it("only warns when the phone reports reduced mode", () => {
    expect(powerWarning(undefined)).toBeUndefined();
    expect(powerWarning({ reduced: false })).toBeUndefined();
    expect(powerWarning({ reduced: true })).toMatch(/1\.5 A/);
  });
});
