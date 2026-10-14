import type { HouseLineKey, HouseLineTarget } from "./api.ts";
import { addressProblem } from "./fields.ts";

/** The server's limit on people in one key's group. */
export const HOUSE_LINE_GROUP_MAX = 10;

/** The keys in keypad order: digits 1–9 then 0 (button index 0–9). */
export const HOUSE_LINE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;
export const indexOfDigit = (digit: number) => (digit === 0 ? 9 : digit - 1);

/** A target as a <select> value: `user:<id>`, `device:<id>`, `group` or `line`. */
export function targetValue(t: HouseLineTarget | undefined): string {
  if (!t) return "";
  if (t.kind === "group") return "group";
  if (t.kind === "line") return "line";
  return t.kind === "user" ? `user:${t.userId}` : `device:${t.deviceId}`;
}

/** Back from a <select> value; a group starts with nobody picked, a line with no address. */
export function parseTarget(value: string, group: string[] = []): HouseLineTarget | undefined {
  if (value === "group") return { kind: "group", userIds: group };
  if (value === "line") return { kind: "line", address: "" };
  const [kind, id] = value.split(":");
  if (!id) return undefined;
  if (kind === "user") return { kind: "user", userId: id };
  if (kind === "device") return { kind: "device", deviceId: id };
  return undefined;
}

/** Replaces (or with no target, clears) the key at `index`; keeps the list in key order. */
export function setKey(
  keys: HouseLineKey[],
  index: number,
  key: Omit<HouseLineKey, "index"> | undefined,
): HouseLineKey[] {
  const rest = keys.filter((k) => k.index !== index);
  const next = key ? [...rest, { index, ...key }] : rest;
  return next.sort((a, b) => a.index - b.index);
}

/** What the server would refuse about a key, in plain words; undefined when it's fine. */
export function keyProblem(k: HouseLineKey): string | undefined {
  if (!k.label.trim()) return "Give it a label.";
  if (k.target.kind === "group") {
    if (k.target.userIds.length === 0) return "Pick at least one person.";
    if (k.target.userIds.length > HOUSE_LINE_GROUP_MAX) {
      return `Pick at most ${HOUSE_LINE_GROUP_MAX} people.`;
    }
  }
  if (k.target.kind === "line") return addressProblem(k.target.address);
  return undefined;
}

/** Keys the server would refuse (see `keyProblem`). */
export function incompleteKeys(keys: HouseLineKey[]): number[] {
  return keys.filter((k) => keyProblem(k) !== undefined).map((k) => k.index);
}
