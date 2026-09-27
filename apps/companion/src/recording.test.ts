import { describe, expect, it } from "vitest";
import { pickRecordingMime } from "./recording.ts";

describe("pickRecordingMime", () => {
  it("prefers Opus in WebM", () => {
    expect(pickRecordingMime(() => true)).toBe("audio/webm;codecs=opus");
  });
  it("falls back to AAC for Safari", () => {
    expect(pickRecordingMime((t) => t.startsWith("audio/mp4"))).toBe("audio/mp4;codecs=mp4a.40.2");
  });
  it("returns undefined when nothing is supported or the check throws", () => {
    expect(pickRecordingMime(() => false)).toBeUndefined();
    expect(
      pickRecordingMime(() => {
        throw new Error("nope");
      }),
    ).toBeUndefined();
  });
});
