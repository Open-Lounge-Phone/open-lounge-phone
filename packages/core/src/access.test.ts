import { describe, expect, it } from "vitest";
import {
  type AccessContext,
  authorizeInbound,
  authorizeOutbound,
  type Contact,
  resolveButton,
} from "./access.ts";

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: "c_grandma",
  label: "Grandma",
  canCallDevice: true,
  deviceCanCall: true,
  bypassQuietHours: false,
  ...over,
});

const allDay: AccessContext = {
  quietHours: {
    timeZone: "UTC",
    rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }],
  },
  now: new Date("2026-03-02T12:00:00Z"),
};
const never: AccessContext = { quietHours: { timeZone: "UTC", rules: [] }, now: allDay.now };

describe("authorizeInbound", () => {
  it("denies unknown callers (default-deny)", () => {
    expect(authorizeInbound(undefined, never)).toEqual({ decision: "deny", reason: "not_allowed" });
  });
  it("denies contacts not allowed to call in", () => {
    expect(authorizeInbound(contact({ canCallDevice: false }), never).decision).toBe("deny");
  });
  it("denies disallowed callers even during quiet hours (no voicemail spam)", () => {
    expect(authorizeInbound(contact({ canCallDevice: false }), allDay).decision).toBe("deny");
  });
  it("rings allowed callers outside quiet hours", () => {
    expect(authorizeInbound(contact(), never)).toEqual({ decision: "ring" });
  });
  it("sends allowed callers to voicemail during quiet hours", () => {
    expect(authorizeInbound(contact(), allDay)).toEqual({
      decision: "voicemail",
      reason: "quiet_hours",
    });
  });
  it("lets bypass contacts ring during quiet hours", () => {
    expect(authorizeInbound(contact({ bypassQuietHours: true }), allDay)).toEqual({
      decision: "ring",
    });
  });
});

describe("authorizeOutbound", () => {
  it("denies unmapped or unknown contacts", () => {
    expect(authorizeOutbound(undefined, never)).toEqual({
      decision: "deny",
      reason: "not_allowed",
    });
    expect(authorizeOutbound(contact({ deviceCanCall: false }), never).decision).toBe("deny");
  });
  it("dials allowed contacts", () => {
    expect(authorizeOutbound(contact(), never)).toEqual({ decision: "dial" });
  });
  it("refuses during quiet hours unless the contact bypasses them", () => {
    expect(authorizeOutbound(contact(), allDay)).toEqual({
      decision: "deny",
      reason: "quiet_hours",
    });
    expect(authorizeOutbound(contact({ bypassQuietHours: true }), allDay)).toEqual({
      decision: "dial",
    });
  });
});

describe("resolveButton", () => {
  const grandma = contact();
  const contacts = new Map([[grandma.id, grandma]]);
  it("resolves mapped buttons", () => {
    expect(resolveButton(new Map([[0, grandma.id]]), contacts, 0)).toBe(grandma);
  });
  it("returns undefined for unmapped buttons and dangling mappings", () => {
    expect(resolveButton(new Map(), contacts, 0)).toBeUndefined();
    expect(resolveButton(new Map([[1, "c_deleted"]]), contacts, 1)).toBeUndefined();
  });
});
