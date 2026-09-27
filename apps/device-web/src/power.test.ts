import { describe, expect, it } from "vitest";
import { parseVariant, powerStatus } from "./power.ts";

describe("powerStatus", () => {
  it("reduces only the Lounge phone, only on a Default source", () => {
    expect(powerStatus("lounge", "default")).toEqual({ source: "default", reduced: true });
    expect(powerStatus("lounge", "1.5A").reduced).toBe(false);
    expect(powerStatus("lounge", "3A").reduced).toBe(false);
    expect(powerStatus("kids", "default").reduced).toBe(false);
  });
  it("defaults to the Kids variant", () => {
    expect(parseVariant(null)).toBe("kids");
    expect(parseVariant("lounge")).toBe("lounge");
    expect(parseVariant("other")).toBe("kids");
  });
});
