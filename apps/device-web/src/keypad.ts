/**
 * The phone's 12 keys, as laid out on the deck:
 *
 *   1 2 3 4 5 MENU
 *   6 7 8 9 0 BACK
 *
 * Digits are speed-dial slots on the wire: protocol `button` index = digit - 1, and digit 0 is
 * index 9. MENU and BACK never leave the device.
 */
export type KeyId = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "0" | "menu" | "back";

export const KEY_ROWS: readonly (readonly KeyId[])[] = [
  ["1", "2", "3", "4", "5", "menu"],
  ["6", "7", "8", "9", "0", "back"],
];

/** Speed-dial slots (digits 0–9). */
export const SLOT_COUNT = 10;

export function isDigit(key: KeyId): boolean {
  return key !== "menu" && key !== "back";
}

/** Protocol button index for a digit key: 1–9 → 0–8, 0 → 9. */
export function slotOf(digit: number): number {
  return digit === 0 ? 9 : digit - 1;
}

/** Digit shown on the key for a protocol button index: 0–8 → 1–9, 9 → 0. */
export function digitOf(slot: number): number {
  return slot === 9 ? 0 : slot + 1;
}

/** Maps a computer keyboard key to a phone key (digits, M = MENU, Backspace/Escape = BACK). */
export function keyFromKeyboard(key: string): KeyId | undefined {
  if (/^[0-9]$/.test(key)) return key as KeyId;
  if (key === "m" || key === "M") return "menu";
  if (key === "Backspace" || key === "Escape") return "back";
  return undefined;
}
