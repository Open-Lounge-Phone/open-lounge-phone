import type { DeviceState } from "@openloungephone/core";
import { describe, expect, it } from "vitest";
import { hasNewMissed, type LedInput, statusLed } from "./leds.ts";

const config = {
  buttons: [
    { index: 0, label: "Mom" },
    { index: 2, label: "Grandma" },
  ],
  quiet: false,
};

const input = (over: Partial<LedInput> = {}): LedInput => ({
  deviceState: { kind: "idle" },
  config,
  pairing: false,
  connection: "online",
  ...over,
});
const state = (s: DeviceState) => input({ deviceState: s });

// docs/phone-ux.md "Status LED" and firmware main.c render(): one red LED.
describe("statusLed", () => {
  it("is dim when ready, breathes with missed calls", () => {
    expect(statusLed(input())).toBe("dim");
    expect(statusLed(input({ config: { ...config, missed: [{ from: "Mom" }] } }))).toBe("breathe");
  });

  it("pulses while pairing or connecting, blinks offline", () => {
    expect(statusLed(input({ pairing: true }))).toBe("pulse");
    expect(statusLed(input({ connection: "connecting" }))).toBe("pulse");
    expect(statusLed(input({ connection: "offline" }))).toBe("blink");
    expect(
      statusLed(
        input({
          connection: "offline",
          deviceState: { kind: "incoming", callId: "c", from: "Mom" },
        }),
      ),
    ).toBe("blink");
  });

  it("flashes while ringing, stays on in calls and rooms", () => {
    expect(statusLed(state({ kind: "incoming", callId: "c", from: "Mom" }))).toBe("ringing");
    expect(statusLed(state({ kind: "dialing", button: 0 }))).toBe("on");
    expect(statusLed(state({ kind: "incall", callId: "c", connected: true }))).toBe("on");
    expect(statusLed(state({ kind: "inroom", roomId: "r", muted: false }))).toBe("on");
  });

  it("double-flashes as the recording light only in a recorded call or room", () => {
    expect(
      statusLed(
        input({ deviceState: { kind: "incall", callId: "c", connected: true }, recording: true }),
      ),
    ).toBe("recording");
    expect(
      statusLed(
        input({ deviceState: { kind: "inroom", roomId: "r", muted: false }, recording: true }),
      ),
    ).toBe("recording");
    expect(statusLed(input({ recording: true }))).toBe("dim");
  });

  it("is dim with the handset up and after calls", () => {
    expect(statusLed(state({ kind: "offhook" }))).toBe("dim");
    expect(statusLed(state({ kind: "offhook", lastEnd: "busy" }))).toBe("dim");
  });
});

describe("hasNewMissed", () => {
  const with_ = (...from: string[]) => ({ ...config, missed: from.map((f) => ({ from: f })) });
  it("detects newly listed callers only", () => {
    expect(hasNewMissed(undefined, with_("Mom"))).toBe(true);
    expect(hasNewMissed(with_("Mom"), with_("Mom"))).toBe(false);
    expect(hasNewMissed(with_("Mom"), with_("Grandma", "Mom"))).toBe(true);
    expect(hasNewMissed(with_("Mom", "Grandma"), with_("Mom"))).toBe(false);
    expect(hasNewMissed(with_("Mom"), config)).toBe(false);
  });
});
