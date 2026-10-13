import { describe, expect, it } from "vitest";
import {
  EPD_H,
  EPD_W,
  frame,
  keyMap,
  lineCapacity,
  lines,
  marquee,
  text,
  textWidth,
} from "./epaper.ts";

const ink = (f: ReturnType<typeof frame>) => f.px.reduce((n, p) => n + p, 0);
const bounds = (f: ReturnType<typeof frame>): [number, number] => {
  let x0 = f.w,
    x1 = -1;
  for (let i = 0; i < f.px.length; i++)
    if (f.px[i]) {
      const x = i % f.w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
  return [x0, x1];
};

describe("epaper (the firmware's screens)", () => {
  it("draws the firmware's 5x7 font", () => {
    const f = frame(12, 7);
    text(f, 0, 0, "1", 1);
    // gfx.c '1' = 0x00, 0x42, 0x7F, 0x40, 0x00: column 2 is all seven pixels.
    expect([0, 1, 2, 3, 4, 5, 6].every((y) => f.px[y * 12 + 2] === 1)).toBe(true);
    expect(f.px[0 * 12 + 0]).toBe(0);
    expect(textWidth("READY", 2)).toBe(58);
  });

  it("centres status lines at the 2.13-inch panel's scale (2x: 20 characters a line)", () => {
    const f = frame();
    expect([f.w, f.h]).toEqual([EPD_W, EPD_H]);
    expect(lineCapacity(2)).toBe(20);
    lines(f, ["READY 14:05", "KIDS: SMITHS"]);
    const [x0, x1] = bounds(f);
    expect(Math.abs(x0 + x1 - (EPD_W - 1))).toBeLessThanOrEqual(4);
    expect(ink(f)).toBeGreaterThan(200);
  });

  it("scrolls long text like marquee.c", () => {
    expect(marquee("MOM", 8, 5)).toBe("MOM");
    expect(marquee("CLAUDE TEST PHONE", 8, 0)).toBe("CLAUDE T");
    expect(marquee("CLAUDE TEST PHONE", 8, 4)).toBe("LAUDE TE");
    expect(marquee("CLAUDE TEST PHONE", 8, 17 + 3 + 3)).toBe("CLAUDE T");
  });

  it("draws the key map with a black title bar", () => {
    const f = frame();
    keyMap(
      f,
      "KIDS: SMITHS",
      ["Mom", "Dad", "", "", "", "", "", "", "", ""],
      "PRESS A KEY TO CALL",
    );
    expect(f.px[5 * EPD_W + 2]).toBe(1); // title bar
    expect(ink(f)).toBeGreaterThan(1000);
  });
});
