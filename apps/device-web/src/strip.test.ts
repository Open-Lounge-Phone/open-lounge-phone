import { describe, expect, it } from "vitest";
import type { DeviceConfig } from "./leds.ts";
import {
  addonLabel,
  MISSED_CYCLE_MS,
  ownerLine,
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
      "ENTER IN APP",
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

  it("labels an add-on calling: SEAT · ADD-ON when it fits", () => {
    const incoming = (from: string) =>
      lines({ deviceState: { kind: "incoming", callId: "c", from, addon: true } });
    expect(incoming("Seat")).toEqual(["SEAT · ADD-ON", "LIFT TO ANSWER"]);
    expect(incoming("Notes taker")).toEqual(["NOTES TAKER", "ADD-ON CALLING"]);
    expect(addonLabel("seat")).toBe("SEAT · ADD-ON");
    expect(addonLabel("thinking-room")).toBe("THINKING-ROOM");
    expect(lines({ deviceState: { kind: "incoming", callId: "c", from: "Seat" } })).toEqual([
      "SEAT CALLING",
      "LIFT TO ANSWER",
    ]);
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

  it("guides leaving a voicemail, and confirms it after hang-up", () => {
    const offer = { ticket: "t".repeat(20), name: "Grandma", maxMs: 120_000, prompts: [] };
    const vm = { kind: "voicemail" as const, offer };
    expect(lines({ deviceState: vm })).toEqual(["LEAVE A MESSAGE", "GRANDMA"]);
    expect(lines({ deviceState: vm, leave: { stage: "recording", remainingMs: 95_000 } })).toEqual([
      "RECORDING 01:35",
      "HANG UP TO SEND",
    ]);
    expect(lines({ leave: { stage: "sent" } })).toEqual(["MESSAGE SENT"]);
    expect(lines({ leave: { stage: "failed" } })).toEqual(["MESSAGE NOT SENT"]);
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
    expect(lines({ clock: "14:05", battery: { pct: 87, charging: true } })).toEqual([
      "READY 14:05",
    ]);
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

  it("shows a single missed caller: kids ask a grown-up, others play it in the app", () => {
    expect(statusLines({ ...base, config: cfg({ missed: [{ from: "Grandma" }] }) })).toEqual([
      "MISSED GRANDMA",
      "ASK A GROWN-UP",
    ]);
    const own = cfg({
      missed: [{ from: "Grandma" }],
      owner: { mode: "personal", space: "Home", person: "Ana" },
    });
    expect(statusLines({ ...base, config: own })).toEqual(["MISSED GRANDMA", "PLAY IN APP"]);
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

  it("names a public line whose call back was missed (no message to play)", () => {
    const one = cfg({ missed: [{ from: "Acme Support", callback: true }] });
    expect(statusLines({ ...base, config: one })).toEqual(["MISSED CALL BACK", "ACME SUPPORT"]);
    // With voicemail too: counted and cycled like any missed call.
    const both = cfg({ missed: [{ from: "Help", callback: true }, { from: "Mom" }] });
    expect(statusLines({ ...base, config: both, now: 0 })).toEqual(["2 MISSED CALLS", "HELP"]);
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

describe("trust line", () => {
  const base = { connection: "online" as const, deviceState: { kind: "idle" as const }, now: 0 };
  it("says whose phone it is and how it's used", () => {
    const config = (owner: NonNullable<Parameters<typeof ownerLine>[0]>) => ({
      buttons: [],
      quiet: false,
      owner,
    });
    expect(statusLines({ ...base, config: config({ mode: "kids", space: "Smith home" }) })).toEqual(
      ["READY", "KIDS: SMITH HOME"],
    );
    expect(ownerLine({ mode: "personal", space: "Home", person: "Jesse" })).toBe("JESSE'S PHONE");
    expect(ownerLine({ mode: "lounge", space: "The Office Space" })).toBe("LOUNGE: THE OFFI");
    expect(ownerLine({ mode: "lounge", space: "The Office Space" }).length).toBeLessThanOrEqual(
      STATUS_WIDTH,
    );
    // Warnings win the second line.
    const low = statusLines({
      ...base,
      battery: { pct: 10, charging: false },
      config: config({ mode: "kids", space: "Home" }),
    });
    expect(low[1]).toBe("LOW BATTERY 10%");
  });
});

describe("hold, 3-way calls and rooms on the strip", () => {
  const base = { connection: "online" as const, now: 10_000 };

  it("shows a caller on hold, being held, and the merge hint", () => {
    expect(statusLines({ ...base, deviceState: { kind: "offhook", held: "c1" } })).toEqual([
      "CALLER ON HOLD",
      "PRESS A KEY",
    ]);
    expect(
      statusLines({
        ...base,
        activeLabel: "Gran",
        deviceState: { kind: "incall", callId: "c1", connected: true, heldByThem: true },
      }),
    ).toEqual(["ON HOLD", "GRAN"]);
    expect(
      statusLines({
        ...base,
        activeLabel: "Gran",
        callStartedAt: 0,
        deviceState: { kind: "incall", callId: "c2", connected: true, held: "c1" },
      }),
    ).toEqual(["GRAN", "MENU: MERGE"]);
    expect(
      statusLines({
        ...base,
        deviceState: { kind: "incall", callId: "c1", connected: true, transferPending: true },
      }),
    ).toEqual(["TRANSFER TO?", "PRESS A KEY"]);
  });

  it("shows the room, who's in, muted, and the idle warning", () => {
    expect(statusLines({ ...base, deviceState: { kind: "inroom", muted: false } })).toEqual([
      "JOINING ROOM",
    ]);
    const inRoom = { kind: "inroom" as const, roomId: "r1", muted: true };
    expect(
      statusLines({
        ...base,
        deviceState: inRoom,
        room: { name: "Cousins", people: 3, muted: true },
      }),
    ).toEqual(["COUSINS", "3 IN ROOM MUTED"]);
    expect(
      statusLines({
        ...base,
        deviceState: inRoom,
        room: { name: "Cousins", people: 3, muted: true, idleWarning: true },
      }),
    ).toEqual(["STILL THERE?", "PRESS ANY KEY"]);
  });
});

describe("recording", () => {
  it("says REC during a recorded call and in a recorded room", async () => {
    const { statusLines } = await import("./strip.ts");
    const base = { connection: "online" as const, now: 65_000, callStartedAt: 0 };
    expect(
      statusLines({
        ...base,
        deviceState: { kind: "incall", callId: "c", connected: true },
        activeLabel: "Ben",
        recording: true,
      }),
    ).toEqual(["REC 01:05", "BEN"]);
    expect(
      statusLines({
        ...base,
        deviceState: { kind: "incall", callId: "c", connected: true },
        activeLabel: "Ben",
      }),
    ).toEqual(["IN CALL 01:05", "BEN"]);
    // Muted (MENU 3): said instead of IN CALL, after REC when both apply.
    const muted = { kind: "incall" as const, callId: "c", connected: true, muted: true };
    expect(statusLines({ ...base, deviceState: muted, activeLabel: "Ben" })).toEqual([
      "MUTED 01:05",
      "BEN",
    ]);
    expect(
      statusLines({ ...base, deviceState: muted, activeLabel: "Ben", recording: true }),
    ).toEqual(["REC MUTED 01:05", "BEN"]);
    expect(
      statusLines({
        ...base,
        deviceState: { kind: "inroom", roomId: "r", muted: false },
        room: { name: "Desk", people: 3, muted: false },
        recording: true,
      }),
    ).toEqual(["DESK", "REC 3 IN ROOM"]);
  });
});

describe("public lines on the strip", () => {
  const dialing = (queue: {
    position?: number;
    size?: number;
    voicemail?: boolean;
    callback?: boolean;
  }) => ({ kind: "dialing", button: 1, callId: "c1", queue }) as const;

  it("shows the place in line and how to leave a voicemail instead", () => {
    expect(
      lines({
        deviceState: dialing({ position: 2, size: 3, voicemail: true }),
        activeLabel: "Help",
      }),
    ).toEqual(["IN LINE 2", "1 VOICEMAIL"]);
    expect(lines({ deviceState: dialing({ position: 1, size: 1 }), activeLabel: "Help" })).toEqual([
      "IN LINE 1",
      "HELP",
    ]);
    expect(lines({ deviceState: dialing({}) })).toEqual(["WAITING IN LINE", "PLEASE WAIT"]);
    expect(
      lines({ deviceState: dialing({ position: 3, voicemail: true, callback: true }) }),
    ).toEqual(["IN LINE 3", "1 VM 2 CALL BACK"]);
    expect(lines({ deviceState: dialing({ position: 3, callback: true }) })).toEqual([
      "IN LINE 3",
      "2 CALL ME BACK",
    ]);
    for (const l of lines({ deviceState: dialing({ position: 12, voicemail: true }) })) {
      expect(l.length).toBeLessThanOrEqual(STATUS_WIDTH);
    }
  });

  it("a free Lounge phone that tried a public line says to sign in", () => {
    expect(lines({ deviceState: { kind: "offhook", lastEnd: "denied", signIn: true } })).toEqual([
      "SIGN IN TO CALL",
      "PRESS A KEY",
    ]);
    expect(lines({ deviceState: { kind: "offhook", lastEnd: "denied" } })).toEqual([
      "NOT ALLOWED",
      "PRESS A KEY",
    ]);
  });

  it("a call back: the place kept, then the line calling", () => {
    expect(lines({ deviceState: { kind: "offhook", lastEnd: "hangup", callback: true } })).toEqual([
      "PLACE KEPT",
      "WE'LL CALL BACK",
    ]);
    expect(
      lines({
        deviceState: { kind: "incoming", callId: "c1", from: "Support", callback: true },
      }),
    ).toEqual(["SUPPORT", "CALLS YOU BACK"]);
  });
});

describe("notices on the strip", () => {
  it("show on the ready screen, over missed calls, until dismissed", () => {
    const config = { buttons: [], quiet: false, missed: [{ from: "Mom", at: 1 }] };
    expect(lines({ notice: { lines: ["BUS IS HERE"] }, config })).toEqual(["BUS IS HERE"]);
    expect(lines({ notice: { lines: ["KITCHEN CLOSES", "AT 10"] } })).toEqual([
      "KITCHEN CLOSES",
      "AT 10",
    ]);
    expect(lines({ config })[0]).not.toBe("BUS IS HERE");
  });
});

describe("a party line closing", () => {
  it("says so in the room", () => {
    expect(
      lines({
        deviceState: { kind: "inroom", roomId: "r1", muted: false },
        room: { name: "Family line", people: 2, muted: false, closing: true },
      }),
    ).toEqual(["CLOSING SOON", "FAMILY LINE"]);
  });
});

describe("the call's connection", () => {
  it("says RECONNECTING instead of a timer, POOR CONNECTION, and CONNECTION LOST", async () => {
    const { statusLines } = await import("./strip.ts");
    const base = {
      connection: "online" as const,
      now: 65_000,
      callStartedAt: 0,
      deviceState: { kind: "incall" as const, callId: "c", connected: true },
      activeLabel: "Ben",
    };
    expect(statusLines({ ...base, reconnecting: true })).toEqual(["RECONNECTING", "BEN"]);
    expect(statusLines({ ...base, poor: true })).toEqual(["IN CALL 01:05", "POOR CONNECTION"]);
    expect(
      statusLines({
        ...base,
        deviceState: { kind: "offhook", lastEnd: "error", lost: true },
      }),
    ).toEqual(["CONNECTION LOST", "PRESS A KEY"]);
    expect(statusLines({ ...base, deviceState: { kind: "offhook", lastEnd: "error" } })).toEqual([
      "CALL FAILED",
      "PRESS A KEY",
    ]);
  });
});
