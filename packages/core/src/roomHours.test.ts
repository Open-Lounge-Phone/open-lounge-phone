import { describe, expect, it } from "vitest";
import {
  opensText,
  ROOM_CLOSING_WARNING_MS,
  type RoomHours,
  roomHoursStep,
  roomOpenAt,
} from "./roomHours.ts";

// Monday 2026-10-12 in New York (UTC-4 in October).
const at = (iso: string) => new Date(iso).getTime();
const fridays: RoomHours = {
  timeZone: "America/New_York",
  rules: [{ days: [5], start: "19:00", end: "21:00" }],
};

describe("party line hours", () => {
  it("open only in its windows, in the space's time zone; no hours = always open", () => {
    expect(roomOpenAt(undefined, at("2026-10-12T12:00:00Z"))).toEqual({ open: true });
    // Friday 19:30 New York = 23:30 UTC.
    expect(roomOpenAt(fridays, at("2026-10-16T23:30:00Z"))).toEqual({
      open: true,
      until: at("2026-10-17T01:00:00Z"),
    });
    expect(roomOpenAt(fridays, at("2026-10-16T22:59:00Z"))).toEqual({
      open: false,
      until: at("2026-10-16T23:00:00Z"),
    });
    expect(opensText(fridays, at("2026-10-12T12:00:00Z"))).toBe("Opens Fri 19:00");
    expect(opensText(fridays, at("2026-10-16T23:30:00Z"))).toBeUndefined();
  });

  it("announces each window once, warns a minute before closing, then closes", () => {
    const opening = at("2026-10-16T23:00:00Z");
    const closing = at("2026-10-17T01:00:00Z");
    // Just opened, never announced: announce; look again when it's time to warn.
    expect(roomHoursStep(fridays, opening, { announcedUntil: null, occupied: false })).toEqual({
      announce: { closesAt: closing },
      next: closing - ROOM_CLOSING_WARNING_MS,
    });
    // Announced already (a restart in the middle): not again.
    expect(
      roomHoursStep(fridays, opening + 5_000, { announcedUntil: closing, occupied: true }),
    ).toEqual({ next: closing - ROOM_CLOSING_WARNING_MS });
    // A minute before: warn the people in it, once.
    const late = closing - 30_000;
    expect(roomHoursStep(fridays, late, { announcedUntil: closing, occupied: true })).toEqual({
      warn: { closesAt: closing },
      next: closing,
    });
    expect(
      roomHoursStep(fridays, late, { announcedUntil: closing, occupied: true, warnedFor: closing }),
    ).toEqual({ next: closing });
    // Closed: end it if anyone's still in; next opening a week later.
    expect(roomHoursStep(fridays, closing, { announcedUntil: closing, occupied: true })).toEqual({
      close: true,
      next: at("2026-10-23T23:00:00Z"),
    });
    // A week later the window is announced again.
    expect(
      roomHoursStep(fridays, at("2026-10-23T23:00:00Z"), {
        announcedUntil: closing,
        occupied: false,
      }).announce,
    ).toEqual({ closesAt: at("2026-10-24T01:00:00Z") });
    expect(roomHoursStep(undefined, opening, { announcedUntil: null, occupied: true })).toEqual({});
  });
});
