import { describe, expect, it } from "vitest";
import { kidSafe, spaceNoun } from "./spaces.ts";

it("calls homes households and keeps kid features to homes", () => {
  expect(spaceNoun(undefined)).toBe("household");
  expect(spaceNoun("home")).toBe("household");
  expect(spaceNoun("team")).toBe("team");
  expect(spaceNoun("org")).toBe("organization");
  expect(kidSafe(undefined)).toBe(true);
  expect(kidSafe("team")).toBe(false);
});

describe("roleNoun", () => {
  it("guardian/contact at home, admin/member at work", async () => {
    const { roleNoun } = await import("./spaces.ts");
    expect(roleNoun("guardian", "home")).toBe("Guardian");
    expect(roleNoun("contact", undefined)).toBe("Contact");
    expect(roleNoun("guardian", "team")).toBe("Admin");
    expect(roleNoun("contact", "org")).toBe("Member");
  });
});
