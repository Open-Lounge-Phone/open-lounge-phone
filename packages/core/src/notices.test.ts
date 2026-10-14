import { describe, expect, it } from "vitest";
import { type NoticeEntry, nextNoticeExpiry, noticeFor, noticeLines } from "./notices.ts";

describe("notice text", () => {
  it("one or two lines of up to 16 characters, in capitals", () => {
    expect(noticeLines("Bus is here")).toEqual({ lines: ["BUS IS HERE"] });
    expect(noticeLines("  Kitchen closes \n  at   10 ")).toEqual({
      lines: ["KITCHEN CLOSES", "AT 10"],
    });
    expect(noticeLines("\n\n")).toEqual({ error: "write a notice" });
    expect(noticeLines("a\nb\nc")).toEqual({ error: "at most two lines" });
    expect(noticeLines("seventeen letters")).toEqual({
      error: "at most 16 characters a line",
    });
    expect(noticeLines("sixteen letters!")).toEqual({ lines: ["SIXTEEN LETTERS!"] });
    expect(noticeLines("Café 🚌")).toEqual({
      error: "use letters, digits and plain punctuation",
    });
  });
});

describe("which notice a phone shows", () => {
  const n = (id: string, createdAt: number, extra: Partial<NoticeEntry> = {}): NoticeEntry => ({
    id,
    createdAt,
    expiresAt: createdAt + 1000,
    endedAt: null,
    deviceIds: null,
    ...extra,
  });

  it("the newest live one for it, unless it dismissed that one", () => {
    const list = [n("a", 0), n("b", 100), n("c", 200, { deviceIds: ["kitchen"] })];
    expect(noticeFor(list, "hall", new Set(), 150)?.id).toBe("b");
    expect(noticeFor(list, "kitchen", new Set(), 250)?.id).toBe("c");
    // Dismissing the newest shows nothing (an older one doesn't come back).
    expect(noticeFor(list, "hall", new Set(["b"]), 150)).toBeUndefined();
    // Expired or taken down: gone.
    expect(noticeFor(list, "hall", new Set(), 1100)?.id).toBe(undefined);
    expect(noticeFor([n("a", 0, { endedAt: 5 })], "hall", new Set(), 10)).toBeUndefined();
  });

  it("knows when the next one expires", () => {
    expect(nextNoticeExpiry([n("a", 0), n("b", 500)], 100)).toBe(1000);
    expect(nextNoticeExpiry([n("a", 0, { endedAt: 1 })], 100)).toBeUndefined();
  });
});
