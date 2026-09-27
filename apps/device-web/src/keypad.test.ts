import { describe, expect, it } from "vitest";
import { digitOf, isDigit, KEY_ROWS, keyFromKeyboard, SLOT_COUNT, slotOf } from "./keypad.ts";

describe("keypad", () => {
  it("lays out 1-5 MENU over 6-0 BACK", () => {
    expect(KEY_ROWS.map((r) => r.join(" "))).toEqual(["1 2 3 4 5 menu", "6 7 8 9 0 back"]);
    expect(KEY_ROWS.flat().filter(isDigit)).toHaveLength(SLOT_COUNT);
  });

  it("maps digits to protocol slots and back (0 is slot 9)", () => {
    expect([1, 2, 5, 9, 0].map(slotOf)).toEqual([0, 1, 4, 8, 9]);
    for (let d = 0; d <= 9; d++) expect(digitOf(slotOf(d))).toBe(d);
  });

  it("maps the computer keyboard", () => {
    expect(keyFromKeyboard("7")).toBe("7");
    expect(keyFromKeyboard("0")).toBe("0");
    expect(keyFromKeyboard("m")).toBe("menu");
    expect(keyFromKeyboard("Escape")).toBe("back");
    expect(keyFromKeyboard("Backspace")).toBe("back");
    expect(keyFromKeyboard("x")).toBeUndefined();
  });
});
