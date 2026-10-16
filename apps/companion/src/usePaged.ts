import { useCallback, useState } from "react";
import { appendOlder, mayHaveMore, olderCursor } from "./paging.ts";

/**
 * A newest-first list the server sends a page at a time: `reset` with the first page, then
 * `older()` adds the page before the oldest shown while `more` says there may be one.
 */
export function usePaged<T extends { id: string }>(
  pageSize: number,
  at: (item: T) => number,
  fetchOlder: (before: number) => Promise<T[]>,
  onError: (message: string) => void,
) {
  const [list, setList] = useState<T[]>([]);
  const [more, setMore] = useState(false);
  const reset = useCallback(
    (first: T[]) => {
      setList(first);
      setMore(mayHaveMore(first, pageSize));
    },
    [pageSize],
  );
  const older = () => {
    const before = olderCursor(list, at);
    if (before === undefined) return;
    fetchOlder(before).then(
      (page) => {
        const next = appendOlder(list, page, pageSize);
        setList(next.list);
        setMore(next.more);
      },
      (e: Error) => onError(e.message),
    );
  };
  return { list, more, reset, older };
}
