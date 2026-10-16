import { describe, expect, it } from "vitest";
import { appendOlder, mayHaveMore, olderCursor } from "./paging.ts";

const e = (id: string, at: number) => ({ id, at });

describe("paging (Show older)", () => {
  it("offers more only after a full page", () => {
    expect(mayHaveMore([1, 2], 2)).toBe(true);
    expect(mayHaveMore([1], 2)).toBe(false);
    expect(mayHaveMore([], 2)).toBe(false);
  });

  it("asks from the oldest shown time, included, so ties aren't skipped", () => {
    expect(olderCursor([e("a", 30), e("b", 20)], (x) => x.at)).toBe(21);
    expect(olderCursor([], (x: { at: number }) => x.at)).toBeUndefined();
  });

  it("adds the older page without repeats, and stops when nothing new came", () => {
    const first = [e("a", 30), e("b", 20)];
    const next = appendOlder(first, [e("b", 20), e("c", 20)], 2);
    expect(next.list.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(next.more).toBe(true);
    // A full page of only repeats: no more "Show older" (it would loop).
    expect(appendOlder(next.list, [e("b", 20), e("c", 20)], 2).more).toBe(false);
    // A short page: the end.
    expect(appendOlder(first, [e("d", 10)], 2)).toEqual({
      list: [...first, e("d", 10)],
      more: false,
    });
  });
});
