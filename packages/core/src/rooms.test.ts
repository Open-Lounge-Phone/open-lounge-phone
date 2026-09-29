import { describe, expect, it } from "vitest";
import {
  forwardFor,
  idleCheck,
  MESH_MAX,
  mayConnect,
  ROOM_IDLE_GRACE_MS,
  ROOM_IDLE_MS,
  type RoomPolicy,
  roomAccess,
  type Speaker,
} from "./rooms.ts";

const sp = (id: string, lastSpokeAt = 0, speaking = false, muted = false): Speaker => ({
  id,
  speaking,
  lastSpokeAt,
  muted,
});

describe("forwarding: everyone up to 4, then the top 3 speakers", () => {
  it("forwards everyone else (not muted) in rooms of up to 4", () => {
    const room = [sp("a"), sp("b"), sp("c", 0, false, true), sp("d")];
    expect(forwardFor("a", room, [])).toEqual(["b", "d"]);
  });

  it("forwards only the 3 most recent speakers in a room of 5 or more", () => {
    const room = [sp("me"), sp("b", 10), sp("c", 50), sp("d", 30), sp("e", 40), sp("f", 20)];
    expect(forwardFor("me", room, [])).toEqual(["c", "e", "d"]);
  });

  it("puts someone speaking now ahead of those who spoke earlier", () => {
    const room = [sp("me"), sp("b", 10, true), sp("c", 50), sp("d", 30), sp("e", 40)];
    expect(forwardFor("me", room, [])).toEqual(["b", "c", "e"]);
  });

  it("keeps the current speakers through a pause instead of reshuffling", () => {
    const room = [sp("me"), sp("b", 5), sp("c", 6), sp("d", 7), sp("e", 90), sp("f", 80)];
    // e and f spoke more recently, but nobody is speaking now: b, c, d stay.
    expect(forwardFor("me", room, ["b", "c", "d"])).toEqual(["d", "c", "b"]);
  });

  it("replaces the one who spoke longest ago when a new person starts speaking", () => {
    const room = [sp("me"), sp("b", 5), sp("c", 6, true), sp("d", 7), sp("e", 90, true)];
    expect(forwardFor("me", room, ["b", "c", "d"]).sort()).toEqual(["c", "d", "e"]);
  });

  it("never forwards the recipient's own audio or a muted participant", () => {
    const room = [sp("me", 99, true), sp("b", 1), sp("c", 2, true, true), sp("d", 3), sp("e", 4)];
    const out = forwardFor("me", room, ["c"]);
    expect(out).not.toContain("me");
    expect(out).not.toContain("c");
    expect(out).toHaveLength(3);
  });

  it("never exceeds three in a big room with many speaking", () => {
    const room = [sp("me"), ...["b", "c", "d", "e", "f", "g"].map((id, i) => sp(id, i, true))];
    expect(forwardFor("me", room, ["b", "c", "d", "e"])).toHaveLength(3);
  });
});

describe("idle drop: 10 minutes of silence and no interaction, a warning, then out", () => {
  it("warns after 10 minutes and drops a minute later", () => {
    expect(idleCheck({ lastActive: 0 }, ROOM_IDLE_MS - 1)).toEqual({
      action: "none",
      next: ROOM_IDLE_MS,
    });
    const warn = idleCheck({ lastActive: 0 }, ROOM_IDLE_MS);
    expect(warn).toEqual({ action: "warn", dropAt: ROOM_IDLE_MS + ROOM_IDLE_GRACE_MS });
    const warnedAt = ROOM_IDLE_MS;
    expect(idleCheck({ lastActive: 0, warnedAt }, warnedAt + ROOM_IDLE_GRACE_MS - 1)).toEqual({
      action: "none",
      next: warnedAt + ROOM_IDLE_GRACE_MS,
    });
    expect(idleCheck({ lastActive: 0, warnedAt }, warnedAt + ROOM_IDLE_GRACE_MS)).toEqual({
      action: "drop",
    });
  });

  it("starts over when they speak or interact after the warning", () => {
    const warnedAt = ROOM_IDLE_MS;
    const active = warnedAt + 10;
    expect(idleCheck({ lastActive: active, warnedAt }, warnedAt + ROOM_IDLE_GRACE_MS)).toEqual({
      action: "none",
      next: active + ROOM_IDLE_MS,
    });
  });
});

describe("room access (default deny)", () => {
  const room = (p: Partial<RoomPolicy> = {}): RoomPolicy => ({
    kind: "phone",
    access: "space",
    locked: false,
    size: 1,
    max: MESH_MAX,
    ...p,
  });
  const outsider = { inSpace: false, connected: false };

  it("lets the space's members in and nobody else", () => {
    expect(roomAccess(room(), { inSpace: true, connected: false })).toEqual({ ok: true });
    expect(roomAccess(room(), outsider)).toEqual({ ok: false, reason: "denied" });
    // A connection of the owner, but the room is for the space only.
    expect(roomAccess(room(), { inSpace: false, connected: true })).toEqual({
      ok: false,
      reason: "denied",
    });
  });

  it("lets the owner's connections in when the room is open to them", () => {
    const open = room({ access: "connections" });
    expect(roomAccess(open, { inSpace: false, connected: true })).toEqual({ ok: true });
    expect(roomAccess(open, outsider)).toEqual({ ok: false, reason: "denied" });
  });

  it("admits a kids' phone only to rooms of its space that are on its allow-list", () => {
    const open = room({ access: "connections", kind: "party" });
    expect(
      roomAccess(open, { inSpace: true, connected: false, kidsPhone: { allowListed: true } }),
    ).toEqual({ ok: true });
    expect(
      roomAccess(open, { inSpace: true, connected: false, kidsPhone: { allowListed: false } }),
    ).toEqual({ ok: false, reason: "denied" });
    // Never outside its space, even through a connection.
    expect(
      roomAccess(open, { inSpace: false, connected: true, kidsPhone: { allowListed: true } }),
    ).toEqual({ ok: false, reason: "denied" });
  });

  it("refuses locked and full rooms, and never admits anyone to a 3-way call by dialing", () => {
    const member = { inSpace: true, connected: false };
    expect(roomAccess(room({ locked: true }), member)).toEqual({ ok: false, reason: "locked" });
    expect(roomAccess(room({ size: MESH_MAX }), member)).toEqual({ ok: false, reason: "full" });
    expect(roomAccess(room({ kind: "call" }), member)).toEqual({ ok: false, reason: "denied" });
  });

  it("says denied (not locked or full) to people who may not come in at all", () => {
    expect(roomAccess(room({ locked: true, size: 9 }), outsider)).toEqual({
      ok: false,
      reason: "denied",
    });
  });
});

describe("kids' phones in merges and transfers", () => {
  const kid = (allowed: string[]) => ({ key: "dev:kid", kidsPhone: { allowed: new Set(allowed) } });

  it("needs every other party on each kids' phone's allow-list", () => {
    expect(
      mayConnect([kid(["usr:mom", "usr:gran"]), { key: "usr:mom" }, { key: "usr:gran" }]),
    ).toBe(true);
    expect(mayConnect([kid(["usr:mom"]), { key: "usr:mom" }, { key: "usr:stranger" }])).toBe(false);
    expect(mayConnect([{ key: "usr:a" }, { key: "usr:b" }])).toBe(true);
  });
});
