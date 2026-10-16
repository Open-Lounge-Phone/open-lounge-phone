import { describe, expect, it } from "vitest";
import { keyIndexOf, keyName, lastUsedPage, moveKey, pageEmpty } from "./speedDialPages.ts";

describe("key pages in the editor", () => {
  it("indexes a page's keys as (page - 1) * 10 + slot", () => {
    expect(keyIndexOf(1, 0)).toBe(0);
    expect(keyIndexOf(1, 9)).toBe(9);
    expect(keyIndexOf(3, 4)).toBe(24);
  });

  it("knows the last page with someone on it, and empty pages", () => {
    expect(lastUsedPage({})).toBe(1);
    expect(lastUsedPage({ "3": "u1" })).toBe(1);
    expect(lastUsedPage({ "3": "u1", "41": "u2" })).toBe(5);
    expect(lastUsedPage({ "41": "" })).toBe(1);
    expect(pageEmpty({ "3": "u1", "41": "u2" }, 2)).toBe(true);
    expect(pageEmpty({ "3": "u1", "41": "u2" }, 5)).toBe(false);
  });

  it("moves someone to a free key, or swaps with whoever is there", () => {
    expect(moveKey({ "2": "ana" }, 2, 13)).toEqual([
      { index: 13, userId: "ana" },
      { index: 2, userId: null },
    ]);
    expect(moveKey({ "2": "ana", "13": "ben" }, 2, 13)).toEqual([
      { index: 13, userId: "ana" },
      { index: 2, userId: "ben" },
    ]);
    expect(moveKey({ "2": "ana" }, 5, 13)).toEqual([]);
    expect(moveKey({ "2": "ana" }, 2, 2)).toEqual([]);
  });

  it("names keys plainly", () => {
    expect(keyName(2, false)).toBe("Key 3");
    expect(keyName(19, true)).toBe("Page 2, key 0");
    expect(keyName(0, true)).toBe("Page 1, key 1");
  });
});
