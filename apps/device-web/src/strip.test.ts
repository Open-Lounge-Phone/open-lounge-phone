import { describe, expect, it } from "vitest";
import { STATUS_WIDTH, type StatusInput, statusLines } from "./strip.ts";

const NOW = 1_000_000;
const base: StatusInput = {
  connection: "online",
  deviceState: { kind: "idle" },
  config: { buttons: [{ index: 0, label: "Mom" }], quiet: false },
  now: NOW,
};
const lines = (over: Partial<StatusInput>) => statusLines({ ...base, ...over });

describe("statusLines", () => {
  it("shows the pairing code in two groups, ahead of everything else", () => {
    expect(lines({ pairingCode: "429117", connection: "offline" })).toEqual([
      "PAIR 429 117",
      "LIFT TO HEAR",
    ]);
  });

  it("reports connectivity", () => {
    expect(lines({ connection: "offline" })).toEqual(["OFFLINE", "RECONNECTING"]);
    expect(lines({ connection: "connecting" })).toEqual(["CONNECTING"]);
  });

  it("describes calls, splitting long names onto the second line", () => {
    expect(lines({ deviceState: { kind: "dialing", button: 0 }, activeLabel: "Mom" })).toEqual([
      "CALLING MOM",
    ]);
    expect(
      lines({ deviceState: { kind: "dialing", button: 0 }, activeLabel: "Grandma Josephine" }),
    ).toEqual(["CALLING", "GRANDMA JOSEPHIN"]);
    expect(lines({ deviceState: { kind: "incoming", callId: "c", from: "Mom" } })).toEqual([
      "MOM CALLING",
      "LIFT TO ANSWER",
    ]);
    expect(
      lines({ deviceState: { kind: "incoming", callId: "c", from: "Grandma Josephine" } }),
    ).toEqual(["GRANDMA JOSEPHIN", "CALLING"]);
  });

  it("runs a call timer once connected", () => {
    const incall = { kind: "incall", callId: "c", connected: true } as const;
    expect(lines({ deviceState: incall, activeLabel: "Mom", callStartedAt: NOW - 83_400 })).toEqual(
      ["IN CALL 01:23", "MOM"],
    );
    expect(lines({ deviceState: incall, callStartedAt: NOW - 2 * 3600_000 })).toEqual([
      "IN CALL 2H00",
    ]);
    expect(lines({ deviceState: { ...incall, connected: false }, activeLabel: "Mom" })).toEqual([
      "CONNECTING",
      "MOM",
    ]);
  });

  it("explains failed calls", () => {
    const after = (lastEnd: "denied" | "busy" | "timeout" | "hangup") =>
      lines({ deviceState: { kind: "offhook", lastEnd } });
    expect(after("denied")).toEqual(["NOT ALLOWED", "PRESS A KEY"]);
    expect(after("busy")[0]).toBe("BUSY");
    expect(after("timeout")[0]).toBe("NO ANSWER");
    expect(after("hangup")).toEqual(["PRESS A KEY"]);
  });

  it("shows ready with battery, quiet hours, and low battery", () => {
    expect(lines({ battery: { pct: 87, charging: true } })).toEqual(["READY 87%"]);
    expect(lines({})).toEqual(["READY"]);
    expect(lines({ config: { buttons: [], quiet: true } })).toEqual(["QUIET HOURS"]);
    expect(lines({ battery: { pct: 14, charging: false } })).toEqual([
      "READY 14%",
      "LOW BATTERY 14%",
    ]);
  });

  it("never exceeds the display width", () => {
    const long = "X".repeat(40);
    const states = [
      { kind: "dialing", button: 0 },
      { kind: "incoming", callId: "c", from: long },
      { kind: "incall", callId: "c", connected: true },
    ] as const;
    for (const deviceState of states) {
      for (const line of lines({ deviceState, activeLabel: long, callStartedAt: 0, now: 9e9 })) {
        expect(line.length).toBeLessThanOrEqual(STATUS_WIDTH);
      }
    }
  });
});
