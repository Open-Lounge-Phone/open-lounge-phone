import { KEYS_PER_PAGE, MAX_KEY_PAGES } from "@openloungephone/protocol";

/**
 * Speed-dial pages (docs/phone-ux.md): ten keys a page, one per digit key. Page 1 is the
 * digits as they have always been; BACK with the handset up shows the next page that has keys.
 * One stored index per key: `(page - 1) * 10 + slot`.
 */

/** The stored key index of a digit's slot (0-9) on a page (1-based). */
export function keyIndex(page: number, slot: number): number {
  return (page - 1) * KEYS_PER_PAGE + slot;
}

/** Which page (1-based) and slot (0-9) a stored key index is. */
export function keyPlace(index: number): { page: number; slot: number } {
  return { page: Math.floor(index / KEYS_PER_PAGE) + 1, slot: index % KEYS_PER_PAGE };
}

/** Whether a stored key index is on a page a phone may have (`pages` ≤ MAX_KEY_PAGES). */
export function validKeyIndex(index: number, pages = MAX_KEY_PAGES): boolean {
  return Number.isInteger(index) && index >= 0 && index < Math.min(pages, MAX_KEY_PAGES) * 10;
}

/**
 * Keys by stored index → what `config` carries: page 1 in `buttons` (slots 0-9), the other
 * pages with keys in `pages` (each key's `index` its slot). `paged` false (a phone that doesn't
 * list `key-pages`): page 1 only, as before. Keys past `maxPages` are left out.
 */
export function splitKeyPages<T extends { index: number }>(
  keys: readonly T[],
  paged: boolean,
  maxPages = MAX_KEY_PAGES,
): { buttons: T[]; pages?: { page: number; buttons: T[] }[] } {
  const byPage = new Map<number, T[]>();
  for (const k of [...keys].sort((a, b) => a.index - b.index)) {
    if (!validKeyIndex(k.index, maxPages)) continue;
    const { page, slot } = keyPlace(k.index);
    if (page > 1 && !paged) continue;
    const list = byPage.get(page) ?? [];
    list.push({ ...k, index: slot });
    byPage.set(page, list);
  }
  const buttons = byPage.get(1) ?? [];
  const pages = [...byPage]
    .filter(([page]) => page > 1)
    .sort(([a], [b]) => a - b)
    .map(([page, list]) => ({ page, buttons: list }));
  return pages.length ? { buttons, pages } : { buttons };
}

/**
 * The pages a phone shows, in order: page 1 always (it's the speed-dial screen), then each
 * later page that has keys. Empty pages aren't shown.
 */
export function shownPages(config: { pages?: readonly { page: number }[] } | undefined): number[] {
  const later = (config?.pages ?? [])
    .map((p) => p.page)
    .filter((p) => Number.isInteger(p) && p > 1 && p <= MAX_KEY_PAGES);
  return [1, ...[...new Set(later)].sort((a, b) => a - b)];
}

/** The page BACK turns to: the next shown one, from the last back to the first. */
export function nextPage(pages: readonly number[], current: number): number {
  const later = pages.find((p) => p > current);
  return later ?? pages[0] ?? 1;
}

/** "PAGE 2/3": the page shown, of the last page with keys (the app's page numbers). */
export function pageLabel(pages: readonly number[], current: number): string {
  return `PAGE ${current}/${pages[pages.length - 1] ?? 1}`;
}
