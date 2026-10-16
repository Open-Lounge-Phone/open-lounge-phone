import { describe, expect, it } from "vitest";
import { keyAt, keyGrid, pageKeys } from "./grid.ts";

describe("keyGrid", () => {
  const config = {
    buttons: [
      { index: 0, label: "Mom" },
      { index: 4, label: "Dad" },
      { index: 9, label: "Nana" },
    ],
    quiet: false,
  };

  it("mirrors the key rows with speed-dial names, 0 = slot 9", () => {
    expect(keyGrid(config)).toEqual([
      ["Mom", "", "", "", "Dad", "Menu"],
      ["", "", "", "", "Nana", "Back"],
    ]);
  });

  it("shows the menu's options instead while the menu is open", () => {
    const view = {
      title: "MENU",
      labels: { 1: "Volume", 0: "About" },
      menuLabel: "Close",
      backLabel: "Close",
    };
    expect(keyGrid(config, view)).toEqual([
      ["Volume", "", "", "", "", "Close"],
      ["", "", "", "", "About", "Close"],
    ]);
  });

  it("is blank but still shaped without config", () => {
    expect(keyGrid(undefined).flat().filter(Boolean)).toEqual(["Menu", "Back"]);
  });

  it("shows the page on screen: page 2's keys in the same rows", () => {
    const paged = { ...config, pages: [{ page: 2, buttons: [{ index: 1, label: "Ben" }] }] };
    expect(keyGrid(paged, undefined, 2)).toEqual([
      ["", "Ben", "", "", "", "Menu"],
      ["", "", "", "", "", "Back"],
    ]);
    expect(keyGrid(paged, undefined, 3).flat().filter(Boolean)).toEqual(["Menu", "Back"]);
    expect(pageKeys(paged, 1)).toBe(paged.buttons);
    expect(keyAt(paged, 11)?.label).toBe("Ben");
    expect(keyAt(paged, 9)?.label).toBe("Nana");
    expect(keyAt(paged, 21)).toBeUndefined();
  });
});
