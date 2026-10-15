import { describe, expect, it } from "vitest";
import { forgetLastDial, isVoicemail, loadLastDial, missedEntries, saveLastDial } from "./calls.ts";

describe("the Missed screen's entries", () => {
  const now = Date.UTC(2026, 9, 13, 15, 0);
  it("missed calls and call backs, not messages; when and how many", () => {
    const entries = missedEntries(
      {
        buttons: [],
        quiet: false,
        missed: [
          { from: "Mom", kind: "call", count: 2, at: Date.UTC(2026, 9, 13, 14, 5), id: "mc_1" },
          { from: "Gran", kind: "voicemail", at: now },
          { from: "Support", callback: true, at: Date.UTC(2026, 9, 12, 9, 12), id: "mcb_1" },
          { from: "Old server", callback: true },
        ],
      },
      now,
      0,
    );
    expect(entries).toEqual([
      { id: "mc_1", from: "Mom", line: "2 CALLS 14:05" },
      { id: "mcb_1", from: "Support", line: "CALLED BACK YESTERDAY 09:12" },
      { from: "Old server", line: "CALLED BACK 15:00" },
    ]);
    expect(isVoicemail({ from: "x" })).toBe(true); // an older server: a message
    expect(isVoicemail({ from: "x", callback: true })).toBe(false);
    expect(missedEntries(undefined, now, 0)).toEqual([]);
  });
});

describe("redial", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  it("remembers the last call per profile, and forgets it on a wipe", () => {
    const s = memory();
    expect(loadLastDial(s, "a")).toBeUndefined();
    saveLastDial(s, "a", { kind: "button", index: 3 });
    saveLastDial(s, "b", { kind: "extension", number: "204" });
    expect(loadLastDial(s, "a")).toEqual({ kind: "button", index: 3 });
    expect(loadLastDial(s, "b")).toEqual({ kind: "extension", number: "204" });
    s.setItem("olp-last-dial:a", JSON.stringify({ kind: "button", index: 99 }));
    expect(loadLastDial(s, "a")).toBeUndefined();
    forgetLastDial(s, "b");
    expect(loadLastDial(s, "b")).toBeUndefined();
  });
});
