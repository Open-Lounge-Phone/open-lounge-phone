import { describe, expect, it } from "vitest";
import { keyLabels, labelFontPt, slotOf } from "./keyLabels.ts";

describe("keyLabels", () => {
  it("lists all ten digit keys in keypad order with their assigned person", () => {
    const contacts = [
      { id: "u1", label: "Mom" },
      { id: "u2", label: "Grandma" },
      { id: "u3", label: "Dad" },
    ];
    const labels = keyLabels({ "0": "u1", "2": "u2", "9": "u3", "3": "gone" }, contacts);
    expect(labels.map((l) => l.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
    expect(labels.map((l) => l.name)).toEqual([
      "Mom",
      "",
      "Grandma",
      "",
      "",
      "",
      "",
      "",
      "",
      "Dad",
    ]);
  });
  it("maps digit 0 to slot 9 and the rest to digit - 1", () => {
    expect([1, 5, 9, 0].map(slotOf)).toEqual([0, 4, 8, 9]);
  });
  it("shrinks the font for long names", () => {
    expect(labelFontPt("Mom")).toBeGreaterThan(labelFontPt("Grandma"));
    expect(labelFontPt("Grandma")).toBeGreaterThan(labelFontPt("Bartholomew"));
    expect(labelFontPt("")).toBe(11);
  });
});
