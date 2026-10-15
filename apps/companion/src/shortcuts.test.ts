import { describe, expect, it } from "vitest";
import { isMuteShortcut } from "./shortcuts.ts";

describe("M mutes", () => {
  it("on M or m, not with modifiers, not held down", () => {
    expect(isMuteShortcut({ key: "m" })).toBe(true);
    expect(isMuteShortcut({ key: "M" })).toBe(true);
    expect(isMuteShortcut({ key: "n" })).toBe(false);
    expect(isMuteShortcut({ key: "m", metaKey: true })).toBe(false);
    expect(isMuteShortcut({ key: "m", ctrlKey: true })).toBe(false);
    expect(isMuteShortcut({ key: "m", altKey: true })).toBe(false);
    expect(isMuteShortcut({ key: "m", repeat: true })).toBe(false);
  });

  it("not while typing in a field", () => {
    expect(isMuteShortcut({ key: "m", target: { tagName: "INPUT", type: "text" } })).toBe(false);
    expect(isMuteShortcut({ key: "m", target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(isMuteShortcut({ key: "m", target: { tagName: "DIV", isContentEditable: true } })).toBe(
      false,
    );
    // A slider or a button has focus: M still mutes.
    expect(isMuteShortcut({ key: "m", target: { tagName: "INPUT", type: "range" } })).toBe(true);
    expect(isMuteShortcut({ key: "m", target: { tagName: "BUTTON" } })).toBe(true);
  });
});
