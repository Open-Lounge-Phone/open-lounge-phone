import { describe, expect, it } from "vitest";
import { keyLabels, labelFontPt } from "./keyLabels.ts";

describe("keyLabels", () => {
  it("lists every key with its assigned person, blank when unassigned", () => {
    const contacts = [
      { id: "u1", label: "Mom" },
      { id: "u2", label: "Grandma" },
    ];
    expect(keyLabels({ "0": "u1", "2": "u2", "3": "gone" }, contacts, 4)).toEqual([
      { key: 1, name: "Mom" },
      { key: 2, name: "" },
      { key: 3, name: "Grandma" },
      { key: 4, name: "" },
    ]);
  });
  it("shrinks the font for long names", () => {
    expect(labelFontPt("Mom")).toBeGreaterThan(labelFontPt("Grandma"));
    expect(labelFontPt("Grandma")).toBeGreaterThan(labelFontPt("Bartholomew"));
    expect(labelFontPt("")).toBe(11);
  });
});
