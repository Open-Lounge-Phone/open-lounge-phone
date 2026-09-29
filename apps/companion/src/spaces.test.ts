import { expect, it } from "vitest";
import { kidSafe, spaceNoun } from "./spaces.ts";

it("calls homes households and keeps kid features to homes", () => {
  expect(spaceNoun(undefined)).toBe("household");
  expect(spaceNoun("home")).toBe("household");
  expect(spaceNoun("team")).toBe("team");
  expect(spaceNoun("org")).toBe("organization");
  expect(kidSafe(undefined)).toBe(true);
  expect(kidSafe("team")).toBe(false);
});
