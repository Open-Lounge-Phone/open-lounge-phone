/** Printable key labels for phones without a display (Kids Lite, relegendable keycaps). */

/** Common 1u relegendable keycap insert (window) size, in millimetres. */
export const LABEL_MM = 14;

export interface KeyLabel {
  key: number; // 1-based, as printed on the phone
  name: string;
}

export function keyLabels(
  buttons: Record<string, string>,
  contacts: { id: string; label: string }[],
  keyCount: number,
): KeyLabel[] {
  const byId = new Map(contacts.map((c) => [c.id, c.label]));
  return Array.from({ length: keyCount }, (_, i) => ({
    key: i + 1,
    name: byId.get(buttons[String(i)] ?? "") ?? "",
  }));
}

/** Font size (pt) that keeps a name legible inside the label: shorter names print bigger. */
export function labelFontPt(name: string): number {
  const longestWord = Math.max(0, ...name.split(/\s+/).map((w) => w.length));
  if (longestWord <= 4) return 11;
  if (longestWord <= 6) return 9;
  if (longestWord <= 9) return 7;
  return 6;
}
