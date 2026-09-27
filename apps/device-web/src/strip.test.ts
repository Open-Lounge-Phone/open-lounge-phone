import { describe, expect, it } from "vitest";
import type { DeviceConfig } from "./leds.ts";
import {
  MISSED_CYCLE_MS,
  STATUS_WIDTH,
  type StatusInput,
  statusLines,
  WEAK_CHARGER,
} from "./strip.ts";

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

describe("quiet hours and missed voicemail", () => {
  const idle = { kind: "idle" } as const;
  const base = { connection: "online" as const, deviceState: idle, now: 0 };
  const cfg = (extra: Partial<DeviceConfig>): DeviceConfig => ({
    buttons: [],
    quiet: false,
    ...extra,
  });

  it("shows when quiet hours end", () => {
    expect(statusLines({ ...base, config: cfg({ quiet: true, quietUntil: "07:00" }) })).toEqual([
      "QUIET TIL 07:00",
    ]);
    expect(statusLines({ ...base, config: cfg({ quiet: true }) })).toEqual(["QUIET HOURS"]);
  });

  it("shows a single missed caller", () => {
    expect(statusLines({ ...base, config: cfg({ missed: [{ from: "Grandma" }] }) })).toEqual([
      "MISSED GRANDMA",
      "ASK A GROWN-UP",
    ]);
  });

  it("falls back to two lines for long names", () => {
    expect(
      statusLines({ ...base, config: cfg({ missed: [{ from: "Grandma Josephine" }] }) }),
    ).toEqual(["MISSED CALL", "GRANDMA JOSEPHIN"]);
  });

  it("counts several callers and cycles their names", () => {
    const config = cfg({ missed: [{ from: "Mom" }, { from: "Grandma" }] });
    expect(statusLines({ ...base, config, now: 0 })).toEqual(["2 MISSED CALLS", "MOM"]);
    expect(statusLines({ ...base, config, now: MISSED_CYCLE_MS })).toEqual([
      "2 MISSED CALLS",
      "GRANDMA",
    ]);
  });

  it("combines quiet hours with missed calls", () => {
    const one = cfg({ quiet: true, quietUntil: "07:00", missed: [{ from: "Grandma" }] });
    expect(statusLines({ ...base, config: one })).toEqual(["QUIET TIL 07:00", "MISSED GRANDMA"]);
    const two = cfg({ quiet: true, missed: [{ from: "A" }, { from: "B" }] });
    expect(statusLines({ ...base, config: two })).toEqual(["QUIET HOURS", "2 MISSED CALLS"]);
  });

  it("prefers a low-battery warning over the grown-up hint", () => {
    const config = cfg({ missed: [{ from: "Mom" }] });
    expect(statusLines({ ...base, config, battery: { pct: 9, charging: false } })).toEqual([
      "MISSED MOM",
      "LOW BATTERY 9%",
    ]);
  });

  it("lets calls, pairing and connectivity override notices", () => {
    const config = cfg({ quiet: true, quietUntil: "07:00", missed: [{ from: "Mom" }] });
    expect(statusLines({ ...base, config, connection: "offline" })[0]).toBe("OFFLINE");
    expect(statusLines({ ...base, config, pairingCode: "123456" })[0]).toBe("PAIR 123 456");
    expect(statusLines({ ...base, config, deviceState: { kind: "offhook" } })).toEqual([
      "PRESS A KEY",
    ]);
  });

  it("always fits the display", () => {
    const config = cfg({
      quiet: true,
      quietUntil: "23:59",
      missed: [{ from: "An Extremely Long Name Indeed" }, { from: "X" }],
    });
    for (const now of [0, MISSED_CYCLE_MS]) {
      for (const line of statusLines({ ...base, config, now })) {
        expect(line.length).toBeLessThanOrEqual(STATUS_WIDTH);
      }
    }
  });
});

describe("weak charger", () => {
  it("asks for a 1.5 A charger when running reduced, without hiding missed calls", () => {
    const base = {
      connection: "online" as const,
      deviceState: { kind: "idle" as const },
      now: 0,
      power: { reduced: true },
    };
    expect(statusLines({ ...base, config: { buttons: [], quiet: false } })).toEqual([
      "READY",
      WEAK_CHARGER,
    ]);
    expect(WEAK_CHARGER.length).toBeLessThanOrEqual(STATUS_WIDTH);
    const missed = statusLines({
      ...base,
      config: { buttons: [], quiet: false, missed: [{ from: "Mom" }] },
    });
    expect(missed[0]).toBe("MISSED MOM");
  });
});
