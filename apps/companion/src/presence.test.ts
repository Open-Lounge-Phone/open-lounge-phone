import { describe, expect, it } from "vitest";
import { presenceOf } from "./presence.ts";
import { endReasonText } from "./text.ts";

describe("presenceOf", () => {
  it("only makes online, available people callable", () => {
    expect(presenceOf({ online: true, available: true })).toEqual({
      dot: "on",
      label: "Available",
      callable: true,
    });
    expect(presenceOf({ online: true, available: false })).toMatchObject({
      dot: "away",
      callable: false,
    });
    expect(presenceOf({ online: false, available: true })).toMatchObject({
      dot: "off",
      label: "Offline",
      callable: false,
    });
    expect(presenceOf(undefined).callable).toBe(false);
  });
});

describe("person-call end reasons", () => {
  it("explains unavailable and offline people", () => {
    expect(endReasonText("unavailable", true)).toBe("Not taking calls right now");
    expect(endReasonText("unreachable", true)).toBe("They're offline — they need the app open");
    expect(endReasonText("unreachable")).toBe("Phone is offline");
  });
});
