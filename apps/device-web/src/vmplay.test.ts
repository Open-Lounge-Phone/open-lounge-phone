import { describe, expect, it } from "vitest";
import {
  CANT_PLAY_MS,
  FETCH_TIMEOUT_MS,
  type VmItem,
  type VmPlayer,
  vmLines,
  vmStart,
  vmStep,
} from "./vmplay.ts";

/** The display's lines (the player must still be open). */
function shown(p: VmPlayer | undefined, playedMs: number): string[] {
  if (!p) throw new Error("the player closed");
  return vmLines(p, playedMs);
}

const a: VmItem = { id: "vm_a", from: "Grandma", durationMs: 12_000, ticket: "t".repeat(20) };
const b: VmItem = { id: "vm_b", from: "Ana", durationMs: 4_000, ticket: "u".repeat(20) };
const old: VmItem = { id: "vm_old", from: "Leo", durationMs: 9_000 };

describe("voicemail on the phone", () => {
  it("plays oldest first and marks a message heard only when it played to the end", () => {
    let r = vmStep(vmStart(false, 0), { type: "items", items: [a, b], now: 1 });
    expect(r.play).toBe(a);
    expect(r.heard).toEqual([]);
    expect(shown(r.player, 4_000)).toEqual([
      "MESSAGE 1 OF 2",
      "GRANDMA",
      "00:04 OF 00:12",
      "1 AGAIN 2 NEXT",
    ]);
    r = vmStep(r.player, { type: "ended", now: 2 });
    expect(r.heard).toEqual(["vm_a"]);
    expect(r.play).toBe(b);
    r = vmStep(r.player, { type: "ended", now: 3 });
    expect(r.heard).toEqual(["vm_b"]);
    expect(r.player?.stage).toBe("note");
    expect(shown(r.player, 0)).toEqual(["NO MORE MESSAGES"]);
  });

  it("1 plays it again, 2 skips without marking it heard, BACK stops", () => {
    const r0 = vmStep(vmStart(false, 0), { type: "items", items: [a, b], now: 1 });
    expect(vmStep(r0.player, { type: "key", key: 1, now: 2 }).play).toBe(a);
    const skipped = vmStep(r0.player, { type: "key", key: 2, now: 2 });
    expect(skipped.heard).toEqual([]);
    expect(skipped.play).toBe(b);
    expect(vmStep(r0.player, { type: "key", key: "back", now: 2 })).toEqual({
      player: undefined,
      heard: [],
      stop: true,
    });
  });

  it("clear marks every unheard message heard without playing", () => {
    const r = vmStep(vmStart(true, 0), { type: "items", items: [a, b], now: 1 });
    expect(r.play).toBeUndefined();
    expect(r.heard).toEqual(["vm_a", "vm_b"]);
    expect(shown(r.player, 0)).toEqual(["VOICEMAIL", "2 CLEARED"]);
  });

  it("a message phones can't play says so and moves on", () => {
    const r = vmStep(vmStart(false, 0), { type: "items", items: [old, a], now: 1 });
    expect(r.play).toBeUndefined();
    expect(shown(r.player, 0)).toEqual(["MESSAGE 1 OF 2", "LEO", "PLAY IN APP", "2 NEXT"]);
    expect(vmStep(r.player, { type: "tick", now: 1 + CANT_PLAY_MS + 1 }).play).toBe(a);
  });

  it("says when there's nothing, or when the server doesn't answer", () => {
    expect(
      shown(vmStep(vmStart(false, 0), { type: "items", items: [], now: 1 }).player, 0),
    ).toEqual(["NO NEW VOICEMAIL"]);
    const late = vmStep(vmStart(false, 0), { type: "tick", now: FETCH_TIMEOUT_MS + 1 });
    expect(shown(late.player, 0)).toEqual(["COULDN'T GET", "VOICEMAIL"]);
  });
});
