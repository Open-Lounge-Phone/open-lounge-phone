// Speed-dial pages in the phone's key editor: ten keys a page (one per digit key), stored as
// one index, (page - 1) * 10 + slot. BACK on the phone turns the page.

/** The stored index of a digit's slot (0-9) on a page (1-based). */
export const keyIndexOf = (page: number, slot: number) => (page - 1) * 10 + slot;

/** The highest page that has someone on it (1 when none do). */
export function lastUsedPage(buttons: Record<string, string>): number {
  let last = 1;
  for (const [k, v] of Object.entries(buttons)) {
    const i = Number(k);
    if (v && Number.isInteger(i) && i >= 0) last = Math.max(last, Math.floor(i / 10) + 1);
  }
  return last;
}

/** Whether a page has nobody on it (the phone skips such a page). */
export function pageEmpty(buttons: Record<string, string>, page: number): boolean {
  for (let slot = 0; slot < 10; slot++) if (buttons[String(keyIndexOf(page, slot))]) return false;
  return true;
}

/**
 * Moving whoever is on key `from` to key `to` (indexes as stored): the changes to make, in
 * order. Someone already on `to` swaps places with them.
 */
export function moveKey(
  buttons: Record<string, string>,
  from: number,
  to: number,
): { index: number; userId: string | null }[] {
  const moving = buttons[String(from)];
  if (!moving || from === to) return [];
  const there = buttons[String(to)] ?? null;
  return [
    { index: to, userId: moving },
    { index: from, userId: there },
  ];
}

/** "Page 2, key 3" (or "Key 3" when the phone has one page). */
export function keyName(index: number, paged: boolean): string {
  const slot = index % 10;
  const digit = slot === 9 ? 0 : slot + 1;
  return paged ? `Page ${Math.floor(index / 10) + 1}, key ${digit}` : `Key ${digit}`;
}
