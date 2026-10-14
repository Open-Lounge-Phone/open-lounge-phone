import { describe, expect, it } from "vitest";
import {
  incompleteKeys,
  indexOfDigit,
  keyProblem,
  parseTarget,
  setKey,
  targetValue,
} from "./houseLine.ts";

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
    // A key saved with a public line shows as one, but nothing picks a line any more.
    expect(targetValue({ kind: "line", address: "help@acme.example" })).toBe("line");
    expect(parseTarget("line")).toBeUndefined();
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
    keys = setKey(keys, 4, {
      label: "Taxi",
      target: { kind: "line", address: "taxi@cabs.example" },
    });
    expect(incompleteKeys(keys)).toEqual([0, 4]);
    expect(setKey(keys, 0, undefined).map((k) => k.index)).toEqual([2, 4]);
  });

  it("says what's missing on each key, like the server checks it", () => {
    const user = { kind: "user" as const, userId: "u" };
    expect(keyProblem({ index: 0, label: "  ", target: user })).toBe("Give it a label.");
    expect(keyProblem({ index: 0, label: "Desk", target: user })).toBeUndefined();
    const group = (n: number) => ({
      index: 1,
      label: "Staff",
      target: { kind: "group" as const, userIds: Array.from({ length: n }, (_, i) => `u${i}`) },
    });
    expect(keyProblem(group(0))).toBe("Pick at least one person.");
    expect(keyProblem(group(10))).toBeUndefined();
    expect(keyProblem(group(11))).toBe("Pick at most 10 people.");
    const line = (address: string) => ({
      index: 2,
      label: "Taxi",
      target: { kind: "line" as const, address },
    });
    // A free phone calls as the space: public lines only for someone signed in.
    expect(keyProblem(line("taxi@cabs.example"))).toBe(
      "Public lines work only for someone signed in at the phone. Pick a person or a group.",
    );
  });
});
