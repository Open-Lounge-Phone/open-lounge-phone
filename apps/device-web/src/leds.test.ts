import type { DeviceState } from "@opentincan/core";
import { describe, expect, it } from "vitest";
import { type LedInput, ledsFor } from "./leds.ts";

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
  buttons: 4,
  ...over,
});

const modes = (over: Partial<LedInput>) =>
  ledsFor(input(over)).keys.map((k) => `${k.color}:${k.mode}`);

describe("ledsFor", () => {
  it("dims mapped keys and turns off unmapped ones when idle", () => {
    expect(modes({})).toEqual(["white:dim", "white:off", "white:dim", "white:off"]);
    expect(ledsFor(input()).status).toEqual({ color: "green", mode: "on" });
  });

  it("pulses everything blue while pairing", () => {
    const leds = ledsFor(input({ pairing: true, config: undefined }));
    expect(leds.keys.every((k) => k.color === "blue" && k.mode === "pulse")).toBe(true);
    expect(leds.status).toEqual({ color: "blue", mode: "pulse" });
  });

  it("shows connection problems on the status LED and darkens keys", () => {
    expect(ledsFor(input({ connection: "offline" })).status).toEqual({ color: "red", mode: "on" });
    expect(ledsFor(input({ connection: "connecting" })).status).toEqual({
      color: "amber",
      mode: "pulse",
    });
    expect(modes({ connection: "offline" }).every((m) => m.endsWith(":off"))).toBe(true);
  });

  it("shows quiet hours in purple", () => {
    expect(ledsFor(input({ config: { ...config, quiet: true } })).status.color).toBe("purple");
  });

  it("lights the dialed key and the in-call key green", () => {
    expect(modes({ deviceState: { kind: "dialing", button: 2 } })[2]).toBe("green:on");
    const incall: DeviceState = { kind: "incall", callId: "c", connected: true };
    expect(modes({ deviceState: incall, activeKey: 0 })[0]).toBe("green:on");
  });

  it("pulses the caller's key on an incoming call, or all keys for an unmapped caller", () => {
    const fromGrandma: DeviceState = { kind: "incoming", callId: "c", from: "Grandma" };
    expect(modes({ deviceState: fromGrandma })).toEqual([
      "white:dim",
      "white:off",
      "green:pulse",
      "white:off",
    ]);
    const fromDad: DeviceState = { kind: "incoming", callId: "c", from: "Dad" };
    expect(modes({ deviceState: fromDad }).every((m) => m === "green:pulse")).toBe(true);
  });

  it("blinks red after a refused call but not after a normal hangup", () => {
    expect(modes({ deviceState: { kind: "offhook", lastEnd: "denied" }, activeKey: 2 })[2]).toBe(
      "red:blink",
    );
    expect(
      modes({ deviceState: { kind: "offhook", lastEnd: "busy" } }).every((m) => m === "red:blink"),
    ).toBe(true);
    expect(modes({ deviceState: { kind: "offhook", lastEnd: "hangup" }, activeKey: 2 })[2]).toBe(
      "white:dim",
    );
  });

  it("ignores out-of-range keys", () => {
    expect(ledsFor(input({ deviceState: { kind: "dialing", button: 9 } })).keys).toHaveLength(4);
  });
});
