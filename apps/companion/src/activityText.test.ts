import { describe, expect, it } from "vitest";
import { type ActivityRow, activityText } from "./activityText.ts";

const row = (r: Partial<ActivityRow>): ActivityRow => ({
  id: "cl_1",
  cursor: "1.cl_1",
  at: 1,
  direction: "in",
  who: "Mom",
  answered: false,
  durationMs: 0,
  ended: "hangup",
  voicemail: false,
  ...r,
});

describe("activityText (a kids' phone's call activity)", () => {
  it("says each call in plain words", () => {
    expect(activityText(row({ answered: true, durationMs: 192_000 }))).toEqual({
      title: "Mom called",
      detail: "Answered · 3:12",
    });
    expect(activityText(row({ ended: "timeout", voicemail: true }))).toEqual({
      title: "Missed call from Mom",
      detail: "Not answered · left a voicemail",
    });
    expect(activityText(row({ direction: "out", ended: "timeout" }))).toEqual({
      title: "Called Mom",
      detail: "No answer",
    });
    expect(activityText(row({ direction: "out", ended: "declined" })).detail).toBe("Mom declined");
  });

  it("says why a call never rang", () => {
    expect(activityText(row({ who: "Dad", ended: "denied", refused: "not_allowed" }))).toEqual({
      title: "Dad tried to call",
      detail: "Not on the phone's list",
    });
    expect(
      activityText(row({ direction: "out", ended: "denied", refused: "quiet_hours" })),
    ).toEqual({ title: "Tried to call Mom", detail: "Quiet hours" });
    expect(activityText(row({ ended: "voicemail", refused: "quiet_hours" })).detail).toBe(
      "Quiet hours: it didn't ring",
    );
    expect(activityText(row({ ended: "unreachable", refused: "offline" })).detail).toBe(
      "The phone was offline",
    );
    expect(
      activityText(row({ ended: "denied", refused: "other", note: "Over this month's calls" }))
        .detail,
    ).toBe("Over this month's calls");
  });
});
