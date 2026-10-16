import { describe, expect, it } from "vitest";
import { phoneLists } from "./phoneLists.ts";

const phone = (
  id: string,
  ownerUserId: string | null,
  kind: "kids" | "lounge" = "kids",
  mode?: "left",
) => ({ id, ownerUserId, kind, ...(mode ? { mode } : {}) });

describe("phoneLists (Home)", () => {
  const devices = [
    phone("desk", "me"),
    phone("virtual", "me"),
    phone("kid", null),
    phone("dad", "dad"),
    phone("lobby", null, "lounge"),
    phone("dana", null, "kids", "left"),
  ];

  it("puts every phone in exactly one list", () => {
    const l = phoneLists(devices, "me");
    expect(l.mine.map((d) => d.id)).toEqual(["desk", "virtual"]);
    expect(l.household.map((d) => d.id)).toEqual(["kid"]);
    expect(l.theirs.map((d) => d.id)).toEqual(["dad"]);
    expect(l.lounge.map((d) => d.id)).toEqual(["lobby"]);
    // The phone of someone who left is never a household (kids') phone.
    expect(l.left.map((d) => d.id)).toEqual(["dana"]);
    const all = [...l.mine, ...l.household, ...l.theirs, ...l.left, ...l.lounge]
      .map((d) => d.id)
      .sort();
    expect(all).toEqual(devices.map((d) => d.id).sort());
  });

  it("without knowing who I am, own phones are someone's", () => {
    const l = phoneLists(devices);
    expect(l.mine).toEqual([]);
    expect(l.theirs.map((d) => d.id)).toEqual(["desk", "virtual", "dad"]);
  });
});
