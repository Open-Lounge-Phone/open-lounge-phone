import { describe, expect, it } from "vitest";
import { incompleteKeys, indexOfDigit, parseTarget, setKey, targetValue } from "./houseLine.ts";

describe("house-line keys", () => {
  it("maps digits to button indexes like the phone (0 is the tenth key)", () => {
    expect(indexOfDigit(1)).toBe(0);
    expect(indexOfDigit(9)).toBe(8);
    expect(indexOfDigit(0)).toBe(9);
  });

  it("round-trips targets through a select value", () => {
    for (const t of [
      { kind: "user" as const, userId: "usr_1" },
      { kind: "device" as const, deviceId: "dev_1" },
    ]) {
      expect(parseTarget(targetValue(t))).toEqual(t);
    }
    expect(parseTarget("group", ["usr_1"])).toEqual({ kind: "group", userIds: ["usr_1"] });
    expect(parseTarget("")).toBeUndefined();
    expect(targetValue(undefined)).toBe("");
  });

  it("keeps one key per index, in order, and spots unfinished ones", () => {
    let keys = setKey([], 2, { label: "Desk", target: { kind: "user", userId: "u" } });
    keys = setKey(keys, 0, { label: "Staff", target: { kind: "group", userIds: [] } });
    keys = setKey(keys, 2, { label: "Front", target: { kind: "user", userId: "v" } });
    expect(keys.map((k) => [k.index, k.label])).toEqual([
      [0, "Staff"],
      [2, "Front"],
    ]);
    expect(incompleteKeys(keys)).toEqual([0]);
    expect(setKey(keys, 0, undefined).map((k) => k.index)).toEqual([2]);
  });
});
