import { describe, expect, it } from "vitest";
import { allowedModes, initialMode } from "./pairMode.ts";

describe("pairing modes", () => {
  it("offers kids and Lounge phones to guardians only, kids only in a home", () => {
    expect(allowedModes(true, true)).toEqual(["kids", "personal", "lounge"]);
    expect(allowedModes(true, false)).toEqual(["personal", "lounge"]);
    expect(allowedModes(false, true)).toEqual(["personal"]);
  });

  it("starts with what the phone was set up as, when that's allowed", () => {
    const all = allowedModes(true, true);
    expect(initialMode(all, "lounge", false)).toBe("lounge");
    expect(initialMode(all, null, true)).toBe("personal");
    expect(initialMode(all, undefined, false)).toBe("kids");
    expect(initialMode(allowedModes(false, true), "lounge", false)).toBe("personal");
    expect(initialMode(allowedModes(true, false), "kids", false)).toBe("personal");
  });
});
