// Lists the server sends a page at a time (newest first): the audit trails and the call log.
// "Show older" asks for the page before the oldest shown; it never hides that more exist.

/** Page sizes the server uses when the app doesn't ask for another. */
export const PAGE_SIZE = { spaceAudit: 200, spaceCalls: 200, operatorAudit: 100 } as const;

/** Whether a page this long may have more behind it. */
export const mayHaveMore = (page: readonly unknown[], pageSize: number): boolean =>
  page.length >= pageSize;

/**
 * Where the next (older) page starts: the oldest shown time, included again (`before` is
 * exclusive), so entries that share that time aren't skipped; `appendOlder` drops repeats.
 */
export function olderCursor<T>(list: readonly T[], at: (item: T) => number): number | undefined {
  const last = list[list.length - 1];
  return last === undefined ? undefined : at(last) + 1;
}

/**
 * The list with an older page added (repeats dropped), and whether to offer "Show older" again:
 * only while a full page brought something new.
 */
export function appendOlder<T extends { id: string }>(
  list: readonly T[],
  older: readonly T[],
  pageSize: number,
): { list: T[]; more: boolean } {
  const seen = new Set(list.map((x) => x.id));
  const fresh = older.filter((x) => !seen.has(x.id));
  return { list: [...list, ...fresh], more: fresh.length > 0 && mayHaveMore(older, pageSize) };
}
