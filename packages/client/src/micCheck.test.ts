import { describe, expect, it } from "vitest";
import { meterFill, rms, SILENT_AFTER_MS, type SilenceState, silenceStep } from "./micCheck.ts";

describe("mic check", () => {
  it("measures the level", () => {
    expect(rms([])).toBe(0);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([0.5, -0.5])).toBeCloseTo(0.5);
    expect(meterFill(0)).toBe(0);
    expect(meterFill(0.001)).toBe(0); // -60 dBFS: empty
    expect(meterFill(1)).toBe(1);
    expect(meterFill(0.01)).toBeCloseTo(0.4); // -40 dBFS
  });

  it("warns after a few seconds of silence while unmuted, not before", () => {
    let s: SilenceState = {};
    const at = (level: number, now: number, muted = false) => {
      const r = silenceStep(s, { level, muted, now });
      s = r.state;
      return r.silent;
    };
    expect(at(0, 0)).toBe(false);
    expect(at(0, SILENT_AFTER_MS - 1)).toBe(false);
    expect(at(0, SILENT_AFTER_MS)).toBe(true);
    // Any sound ends it and starts the count over.
    expect(at(0.05, SILENT_AFTER_MS + 100)).toBe(false);
    expect(at(0, SILENT_AFTER_MS + 200)).toBe(false);
    expect(at(0, 2 * SILENT_AFTER_MS + 199)).toBe(false);
    expect(at(0, 2 * SILENT_AFTER_MS + 200)).toBe(true);
    // Muted: that silence is yours, so no warning; unmuting starts over.
    expect(at(0, 3 * SILENT_AFTER_MS, true)).toBe(false);
    expect(at(0, 3 * SILENT_AFTER_MS + 1)).toBe(false);
  });
});
