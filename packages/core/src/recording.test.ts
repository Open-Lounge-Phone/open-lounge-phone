import { describe, expect, it } from "vitest";
import { mayEnableRecording, pickRecorder, recordingDecision } from "./recording.ts";

describe("recording rules", () => {
  it("is off unless enabled, never with kids' phones in the space or on the call", () => {
    const base = { enabled: true, spaceKidsPhones: 0, kidsPhoneOnCall: false };
    expect(recordingDecision(base)).toEqual({ record: true });
    expect(recordingDecision({ ...base, enabled: false })).toEqual({ record: false, why: "off" });
    expect(recordingDecision({ ...base, spaceKidsPhones: 1 })).toEqual({
      record: false,
      why: "kids_space",
    });
    expect(recordingDecision({ ...base, kidsPhoneOnCall: true })).toEqual({
      record: false,
      why: "kids_on_call",
    });
  });

  it("a home with kids' phones can't turn it on; teams and kid-free homes can", () => {
    expect(mayEnableRecording({ type: "home", kidsPhones: 1 }).ok).toBe(false);
    expect(mayEnableRecording({ type: "home", kidsPhones: 0 }).ok).toBe(true);
    expect(mayEnableRecording({ type: "team", kidsPhones: 0 }).ok).toBe(true);
  });

  it("the recorder is a local client that can record, the host first", () => {
    expect(
      pickRecorder([
        { id: "remote", local: false, canRecord: true, host: true },
        { id: "a", local: true, canRecord: true },
        { id: "b", local: true, canRecord: true, host: true },
      ]),
    ).toBe("b");
    expect(
      pickRecorder([
        { id: "fw", local: true, canRecord: false },
        { id: "a", local: true, canRecord: true },
      ]),
    ).toBe("a");
    expect(pickRecorder([{ id: "x", local: false, canRecord: true }])).toBeUndefined();
  });
});
