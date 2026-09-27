/** Printable key labels for phones without a display (Kids Lite, relegendable keycaps). */

/** Common 1u relegendable keycap insert (window) size, in millimetres. */
export const LABEL_MM = 14;

/**
 * The phone's digit keys in keypad order (1 2 3 4 5 / 6 7 8 9 0). Each is a speed-dial slot:
 * slot index = digit - 1, and digit 0 is slot 9 (as on the wire).
 */
export const SPEED_DIAL_ROWS: readonly (readonly number[])[] = [
  [1, 2, 3, 4, 5],
  [6, 7, 8, 9, 0],
];

export function slotOf(digit: number): number {
  return digit === 0 ? 9 : digit - 1;
}

export interface KeyLabel {
  /** Digit printed on the key. */
  key: number;
  /** Speed-dial slot (protocol button index). */
  slot: number;
  name: string;
}

/** Labels for every digit key, in keypad order. */
export function keyLabels(
  buttons: Record<string, string>,
  contacts: { id: string; label: string }[],
): KeyLabel[] {
  const byId = new Map(contacts.map((c) => [c.id, c.label]));
  return SPEED_DIAL_ROWS.flat().map((key) => {
    const slot = slotOf(key);
    return { key, slot, name: byId.get(buttons[String(slot)] ?? "") ?? "" };
  });
}

/** Font size (pt) that keeps a name legible inside the label: shorter names print bigger. */
export function labelFontPt(name: string): number {
  const longestWord = Math.max(0, ...name.split(/\s+/).map((w) => w.length));
  if (longestWord <= 4) return 11;
  if (longestWord <= 6) return 9;
  if (longestWord <= 9) return 7;
  return 6;
}
