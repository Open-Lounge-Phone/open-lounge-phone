import { describe, expect, it } from "vitest";
import {
  afterHoursAction,
  csvCell,
  directoryMatch,
  effectiveHours,
  huntSteps,
  isExtension,
  isOpen,
  mayChangeRole,
  nextRoundRobin,
  spaceRole,
} from "./workplace.ts";

const all = () => true;

describe("workplace rules", () => {
  it("extensions are 2–6 digits", () => {
    expect(isExtension("201")).toBe(true);
    expect(isExtension("4400")).toBe(true);
    expect(isExtension("1")).toBe(false);
    expect(isExtension("1234567")).toBe(false);
    expect(isExtension("20a")).toBe(false);
  });

  it("roles: guardian = admin, the first one is the owner; only the owner changes roles", () => {
    expect(spaceRole("guardian", true)).toBe("owner");
    expect(spaceRole("guardian", false)).toBe("admin");
    expect(spaceRole("contact", true)).toBe("member");
    expect(mayChangeRole("owner", "member", "admin")).toEqual({ ok: true });
    expect(mayChangeRole("owner", "admin", "member")).toEqual({ ok: true });
    expect(mayChangeRole("admin", "member", "admin").ok).toBe(false);
    expect(mayChangeRole("owner", "owner", "member").ok).toBe(false);
    expect(mayChangeRole("owner", "admin", "admin").ok).toBe(false);
  });

  it("hunt steps: simultaneous, sequential, round robin; unavailable members skipped", () => {
    const m = ["a", "b", "c"];
    expect(huntSteps("simultaneous", m, all)).toEqual([["a", "b", "c"]]);
    expect(huntSteps("sequential", m, all)).toEqual([["a"], ["b"], ["c"]]);
    expect(huntSteps("round_robin", m, all, 1)).toEqual([["b"], ["c"], ["a"]]);
    expect(huntSteps("round_robin", m, all, 5)).toEqual([["c"], ["a"], ["b"]]);
    expect(huntSteps("sequential", m, (u) => u !== "b")).toEqual([["a"], ["c"]]);
    expect(huntSteps("simultaneous", m, () => false)).toEqual([]);
    expect(huntSteps("round_robin", [], all, 3)).toEqual([]);
    expect(nextRoundRobin(m, "c")).toBe(0);
    expect(nextRoundRobin(m, "a")).toBe(1);
    expect(nextRoundRobin(m, "zz")).toBe(0);
  });

  it("business hours: no rules = open; otherwise the open windows", () => {
    // Monday 2026-03-02 12:00 UTC and 20:00 UTC.
    const noon = new Date(Date.UTC(2026, 2, 2, 12));
    const evening = new Date(Date.UTC(2026, 2, 2, 20));
    const weekdays = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }];
    expect(isOpen(undefined, noon)).toBe(true);
    const hours = effectiveHours("UTC", null, weekdays);
    expect(isOpen(hours, noon)).toBe(true);
    expect(isOpen(hours, evening)).toBe(false);
    // A group's own hours win over the space's.
    const late = [{ days: [1], start: "18:00", end: "22:00" }];
    expect(isOpen(effectiveHours("UTC", late, weekdays), evening)).toBe(true);
    expect(effectiveHours("UTC", null, null)).toBeUndefined();
  });

  it("after hours: group's action, else space's, else voicemail; never forwards twice", () => {
    const toSupport = { kind: "group" as const, groupId: "g2" };
    expect(afterHoursAction(null, null, false, "g1")).toEqual({ kind: "voicemail" });
    expect(afterHoursAction(null, toSupport, false, "g1")).toEqual(toSupport);
    expect(afterHoursAction({ kind: "user", userId: "u" }, toSupport, false, "g1")).toEqual({
      kind: "user",
      userId: "u",
    });
    expect(afterHoursAction(toSupport, null, true, "g1")).toEqual({ kind: "voicemail" });
    expect(afterHoursAction(toSupport, null, false, "g2")).toEqual({ kind: "voicemail" });
  });

  it("directory search and CSV cells", () => {
    const e = { name: "Ana Lopez", handle: "ana", extension: "201" };
    expect(directoryMatch("", e)).toBe(true);
    expect(directoryMatch("lop", e)).toBe(true);
    expect(directoryMatch("ANA", e)).toBe(true);
    expect(directoryMatch("20", e)).toBe(true);
    expect(directoryMatch("01", e)).toBe(false);
    expect(directoryMatch("bob", e)).toBe(false);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });
});
