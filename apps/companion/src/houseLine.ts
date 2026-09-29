import type { HouseLineKey, HouseLineTarget } from "./api.ts";

/** The keys in keypad order: digits 1–9 then 0 (button index 0–9). */
export const HOUSE_LINE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] as const;
export const indexOfDigit = (digit: number) => (digit === 0 ? 9 : digit - 1);

/** A target as a <select> value: `user:<id>`, `device:<id>` or `group`. */
export function targetValue(t: HouseLineTarget | undefined): string {
  if (!t) return "";
  if (t.kind === "group") return "group";
  return t.kind === "user" ? `user:${t.userId}` : `device:${t.deviceId}`;
}

/** Back from a <select> value; a group starts with nobody picked. */
export function parseTarget(value: string, group: string[] = []): HouseLineTarget | undefined {
  if (value === "group") return { kind: "group", userIds: group };
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

/** Keys the server would refuse: a group with nobody in it, or a missing label. */
export function incompleteKeys(keys: HouseLineKey[]): number[] {
  return keys
    .filter((k) => !k.label.trim() || (k.target.kind === "group" && k.target.userIds.length === 0))
    .map((k) => k.index);
}
