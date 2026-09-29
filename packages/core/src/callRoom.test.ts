import { describe, expect, it } from "vitest";
import { newRoom, type RoomEvent, type RoomState, roomStep } from "./callRoom.ts";

const run = (events: RoomEvent[], start: RoomState = newRoom("kid", "mom")) =>
  events.reduce<RoomState>((s, e) => {
    const r = roomStep(s, e);
    if (!r.ok) throw new Error(r.error);
    return r.state;
  }, start);

describe("roomStep", () => {
  it("goes ringing -> connecting -> active -> ended on the happy path", () => {
    const s = run([{ type: "answer", by: "mom" }, { type: "connected" }]);
    expect(s.phase).toBe("active");
    expect(run([{ type: "hangup", by: "kid" }], s)).toMatchObject({
      phase: "ended",
      reason: "hangup",
    });
  });

  it("distinguishes caller cancel from callee decline while ringing", () => {
    expect(run([{ type: "hangup", by: "kid" }]).reason).toBe("hangup");
    expect(run([{ type: "hangup", by: "mom" }]).reason).toBe("declined");
  });

  it("times out unanswered calls and stalled media differently", () => {
    expect(run([{ type: "timeout" }]).reason).toBe("timeout");
    expect(run([{ type: "answer", by: "mom" }, { type: "timeout" }]).reason).toBe("unreachable");
  });

  it("ends with error on failure from any live phase", () => {
    expect(
      run([{ type: "answer", by: "mom" }, { type: "connected" }, { type: "fail" }]).reason,
    ).toBe("error");
  });

  it("rejects strangers and caller self-answer", () => {
    const s = newRoom("kid", "mom");
    expect(roomStep(s, { type: "hangup", by: "stranger" }).ok).toBe(false);
    expect(roomStep(s, { type: "answer", by: "kid" }).ok).toBe(false);
  });

  it("rejects connected before answer", () => {
    expect(roomStep(newRoom("kid", "mom"), { type: "connected" }).ok).toBe(false);
  });

  it("treats duplicates as no-ops", () => {
    const connecting = run([{ type: "answer", by: "mom" }]);
    expect(roomStep(connecting, { type: "answer", by: "mom" })).toEqual({
      ok: true,
      state: connecting,
      changed: false,
    });
    const active = run([{ type: "connected" }], connecting);
    expect(roomStep(active, { type: "connected" })).toMatchObject({ changed: false });
  });

  it("absorbs every event once ended", () => {
    const ended = run([{ type: "hangup", by: "kid" }]);
    for (const e of [
      { type: "answer", by: "mom" },
      { type: "hangup", by: "stranger" },
      { type: "connected" },
      { type: "timeout" },
      { type: "fail" },
    ] as RoomEvent[]) {
      expect(roomStep(ended, e)).toEqual({ ok: true, state: ended, changed: false });
    }
  });
});

it("ends with the reason another server gave", () => {
  const r = roomStep(newRoom("a", "b"), { type: "end", reason: "unavailable" });
  expect(r).toMatchObject({
    ok: true,
    changed: true,
    state: { phase: "ended", reason: "unavailable" },
  });
});
