import { describe, expect, it } from "vitest";
import {
  keyIndex,
  keyPlace,
  nextPage,
  pageLabel,
  shownPages,
  splitKeyPages,
  validKeyIndex,
} from "./keyPages.ts";

describe("speed-dial pages", () => {
  it("stores a key as (page - 1) * 10 + slot", () => {
    expect(keyIndex(1, 0)).toBe(0);
    expect(keyIndex(1, 9)).toBe(9);
    expect(keyIndex(2, 0)).toBe(10);
    expect(keyIndex(10, 9)).toBe(99);
    expect(keyPlace(37)).toEqual({ page: 4, slot: 7 });
    expect(keyPlace(9)).toEqual({ page: 1, slot: 9 });
  });

  it("valid indexes: 0-99, fewer when a server allows fewer pages", () => {
    expect(validKeyIndex(0)).toBe(true);
    expect(validKeyIndex(99)).toBe(true);
    expect(validKeyIndex(100)).toBe(false);
    expect(validKeyIndex(-1)).toBe(false);
    expect(validKeyIndex(1.5)).toBe(false);
    expect(validKeyIndex(29, 3)).toBe(true);
    expect(validKeyIndex(30, 3)).toBe(false);
    expect(validKeyIndex(99, 50)).toBe(true); // never past the protocol's 10 pages
    expect(validKeyIndex(100, 50)).toBe(false);
  });

  it("splits keys into page 1 and the later pages with keys", () => {
    const keys = [
      { index: 31, label: "D" },
      { index: 0, label: "A" },
      { index: 12, label: "B" },
      { index: 19, label: "C" },
    ];
    expect(splitKeyPages(keys, true)).toEqual({
      buttons: [{ index: 0, label: "A" }],
      pages: [
        {
          page: 2,
          buttons: [
            { index: 2, label: "B" },
            { index: 9, label: "C" },
          ],
        },
        { page: 4, buttons: [{ index: 1, label: "D" }] },
      ],
    });
  });

  it("a phone without key-pages gets page 1 only, exactly as before", () => {
    const keys = [
      { index: 3, label: "A" },
      { index: 12, label: "B" },
    ];
    expect(splitKeyPages(keys, false)).toEqual({ buttons: [{ index: 3, label: "A" }] });
    expect(splitKeyPages([{ index: 3, label: "A" }], true)).toEqual({
      buttons: [{ index: 3, label: "A" }],
    });
  });

  it("leaves out keys past the pages allowed", () => {
    expect(splitKeyPages([{ index: 25 }, { index: 1 }], true, 2)).toEqual({
      buttons: [{ index: 1 }],
    });
  });

  it("shows page 1 always, then the later pages with keys; BACK wraps", () => {
    expect(shownPages(undefined)).toEqual([1]);
    expect(shownPages({ pages: [{ page: 4 }, { page: 2 }] })).toEqual([1, 2, 4]);
    expect(shownPages({ pages: [{ page: 1 }, { page: 11 }] })).toEqual([1]);
    expect(nextPage([1, 2, 4], 1)).toBe(2);
    expect(nextPage([1, 2, 4], 2)).toBe(4);
    expect(nextPage([1, 2, 4], 4)).toBe(1);
    expect(nextPage([1, 2, 4], 3)).toBe(4); // a page that emptied meanwhile
    expect(nextPage([1], 1)).toBe(1);
    expect(pageLabel([1, 2, 4], 2)).toBe("PAGE 2/4");
  });
});
