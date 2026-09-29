import { describe, expect, it } from "vitest";
import {
  type DeviceInput,
  type DeviceState,
  deviceStep,
  initialDeviceState,
  soundFor,
} from "./device.ts";

const hook = (state: "up" | "down"): DeviceInput => ({ type: "hook", state });
const button = (index: number): DeviceInput => ({ type: "button", index });
const ringing = (callId: string): DeviceInput => ({
  type: "server",
  msg: { t: "call.ringing", callId, from: { label: "Mom" } },
});
const callState = (
  callId: string,
  state: "requesting" | "ringing" | "connecting" | "active" | "ended",
  reason?: "hangup" | "denied",
): DeviceInput => ({
  type: "server",
  msg: { t: "call.state", callId, state, ...(reason ? { reason } : {}) },
});

function run(inputs: DeviceInput[], start: DeviceState = initialDeviceState) {
  const sent: unknown[] = [];
  let state = start;
  for (const i of inputs) {
    const r = deviceStep(state, i);
    state = r.state;
    sent.push(...r.send);
  }
  return { state, sent };
}

describe("voicemail after an unanswered call", () => {
  const offer = {
    ticket: "t".repeat(43),
    name: "Grandma",
    maxMs: 120_000,
    prompts: ["name", "vm.cant_take", "vm.leave_message", "vm.tone"] as const,
  };
  const endedWithOffer: DeviceInput = {
    type: "server",
    msg: {
      t: "call.state",
      callId: "c1",
      state: "ended",
      reason: "timeout",
      voicemail: { ...offer, prompts: [...offer.prompts] },
    },
  };

  it("records after the greeting and returns to idle on hang-up, without a hangup message", () => {
    const { state } = run([hook("up"), button(0), callState("c1", "ringing"), endedWithOffer]);
    expect(state).toMatchObject({ kind: "voicemail", offer: { name: "Grandma" } });
    expect(soundFor(state)).toBe("none");
    // Keys do nothing while leaving a message.
    expect(deviceStep(state, button(3)).send).toEqual([]);
    const down = deviceStep(state, hook("down"));
    expect(down.state).toEqual({ kind: "idle" });
    expect(down.send).toEqual([{ t: "hook", state: "down" }]);
  });

  it("an ended call without an offer still just ends", () => {
    const { state } = run([hook("up"), button(0), callState("c1", "ended", "denied")]);
    expect(state).toEqual({ kind: "offhook", lastEnd: "denied" });
  });
});

describe("outbound calls", () => {
  it("lift, press, connect, hang up", () => {
    const { state, sent } = run([
      hook("up"),
      button(2),
      callState("c1", "ringing"),
      callState("c1", "active"),
      hook("down"),
    ]);
    expect(state).toEqual({ kind: "idle" });
    expect(sent).toEqual([
      { t: "hook", state: "up" },
      { t: "button", index: 2 },
      { t: "call.hangup", callId: "c1" },
      { t: "hook", state: "down" },
    ]);
  });

  it("plays dial tone, then ringback, then silence in call", () => {
    let s = run([hook("up")]).state;
    expect(soundFor(s)).toBe("dialtone");
    s = run([button(0)], s).state;
    expect(soundFor(s)).toBe("ringback");
    s = run([callState("c1", "active")], s).state;
    expect(soundFor(s)).toBe("none");
  });

  it("ignores buttons with the handset down or mid-call", () => {
    expect(run([button(1)]).sent).toEqual([]);
    const inCall = run([hook("up"), button(0), callState("c1", "active")]).state;
    expect(run([button(1)], inCall).sent).toEqual([]);
  });

  it("plays busy tone when the call is denied, and can redial", () => {
    const denied = run([hook("up"), button(0), callState("c1", "ended", "denied")]).state;
    expect(denied).toEqual({ kind: "offhook", lastEnd: "denied" });
    expect(soundFor(denied)).toBe("busy");
    expect(run([button(1)], denied).state).toEqual({ kind: "dialing", button: 1 });
  });

  it("hangs up before the server assigned a call id without sending call.hangup", () => {
    const { sent } = run([hook("up"), button(0), hook("down")]);
    expect(sent).toEqual([
      { t: "hook", state: "up" },
      { t: "button", index: 0 },
      { t: "hook", state: "down" },
    ]);
  });

  it("ignores state for other calls once a call id is known", () => {
    const dialing = run([hook("up"), button(0), callState("c1", "ringing")]).state;
    expect(run([callState("c2", "ended")], dialing).state).toEqual(dialing);
  });
});

describe("inbound calls", () => {
  it("rings, answers on lift, hangs up on cradle", () => {
    let r = run([ringing("c9")]);
    expect(r.state).toEqual({ kind: "incoming", callId: "c9", from: "Mom" });
    expect(soundFor(r.state)).toBe("ring");
    r = run([hook("up"), callState("c9", "active"), hook("down")], r.state);
    expect(r.sent).toEqual([
      { t: "hook", state: "up" },
      { t: "call.answer", callId: "c9" },
      { t: "call.hangup", callId: "c9" },
      { t: "hook", state: "down" },
    ]);
    expect(r.state).toEqual({ kind: "idle" });
  });

  it("stops ringing when the caller gives up", () => {
    expect(run([ringing("c9"), callState("c9", "ended")]).state).toEqual({ kind: "idle" });
  });

  it("declines a second call while busy", () => {
    const busy = run([hook("up")]).state;
    const r = run([ringing("c9")], busy);
    expect(r.state).toBe(busy);
    expect(r.sent).toEqual([{ t: "call.hangup", callId: "c9" }]);
  });

  it("returns to dial tone when the far end hangs up", () => {
    const inCall = run([ringing("c9"), hook("up"), callState("c9", "active")]).state;
    const s = run([callState("c9", "ended", "hangup")], inCall).state;
    expect(s).toEqual({ kind: "offhook", lastEnd: "hangup" });
  });
});

describe("hold, add caller, merge and transfer (MENU)", () => {
  const act = (
    action: "hold" | "resume" | "merge" | "transfer" | "mute" | "unmute",
  ): DeviceInput => ({
    type: "action",
    action,
  });
  const active = (callId: string, extra: Record<string, unknown> = {}): DeviceInput => ({
    type: "server",
    msg: { t: "call.state", callId, state: "active", ...extra },
  });
  const ended = (callId: string, extra: Record<string, unknown> = {}): DeviceInput => ({
    type: "server",
    msg: { t: "call.state", callId, state: "ended", reason: "hangup", ...extra },
  });
  const inCall = [hook("up"), button(0), callState("c1", "ringing"), active("c1")];

  it("adds a caller: hold, dial another key, then merge into a room", () => {
    const { state, sent } = run([...inCall, act("hold"), button(1), callState("c2", "ringing")]);
    expect(sent).toContainEqual({ t: "call.hold", callId: "c1", hold: true });
    expect(state).toEqual({ kind: "dialing", button: 1, callId: "c2", held: "c1" });
    const consult = run([active("c2"), act("merge")], state);
    expect(consult.sent).toEqual([{ t: "call.merge", callId: "c1", with: "c2" }]);
    expect(consult.state).toEqual({ kind: "inroom", muted: false });
    // Both calls end as merged; then the room arrives.
    const merged = run(
      [
        ended("c1", { merged: { roomId: "r1" } }),
        ended("c2", { merged: { roomId: "r1" } }),
        {
          type: "server",
          msg: {
            t: "room.state",
            roomId: "r1",
            name: "3-way call",
            kind: "call",
            you: "p1",
            locked: false,
            media: "mesh",
            e2ee: true,
            participants: [{ id: "p1", name: "Me", muted: false }],
          },
        },
      ],
      consult.state,
    );
    expect(merged.state).toEqual({ kind: "inroom", roomId: "r1", muted: false });
    expect(merged.sent).toEqual([]);
    // Hanging up leaves the room.
    expect(deviceStep(merged.state, hook("down")).send).toEqual([
      { t: "room.leave", roomId: "r1" },
      { t: "hook", state: "down" },
    ]);
  });

  it("dial tone while holding; resume brings the first call back", () => {
    const held = run([...inCall, act("hold")]);
    expect(held.state).toEqual({ kind: "offhook", held: "c1" });
    expect(soundFor(held.state)).toBe("dialtone");
    const back = run([act("resume")], held.state);
    expect(back.sent).toEqual([{ t: "call.hold", callId: "c1", hold: false }]);
    expect(back.state).toEqual({ kind: "incall", callId: "c1", connected: true });
  });

  it("the consult call failing leaves you with the held call; the held one ending too", () => {
    const busy = run([...inCall, act("hold"), button(1), callState("c2", "ringing")]);
    const failed = run(
      [{ type: "server", msg: { t: "call.state", callId: "c2", state: "ended", reason: "busy" } }],
      busy.state,
    );
    expect(failed.state).toEqual({ kind: "offhook", lastEnd: "busy", held: "c1" });
    // The held person hangs up.
    expect(run([ended("c1")], failed.state).state).toEqual({ kind: "offhook", lastEnd: "hangup" });
  });

  it("hanging up with a call on hold ends both calls", () => {
    const { state } = run([
      ...inCall,
      act("hold"),
      button(1),
      callState("c2", "ringing"),
      active("c2"),
    ]);
    expect(deviceStep(state, hook("down")).send).toEqual([
      { t: "call.hangup", callId: "c2" },
      { t: "call.hangup", callId: "c1" },
      { t: "hook", state: "down" },
    ]);
  });

  it("plays the soft hold tone while the other side holds you", () => {
    const { state } = run([...inCall, active("c1", { hold: "them" })]);
    expect(state).toMatchObject({ kind: "incall", heldByThem: true });
    expect(soundFor(state)).toBe("hold");
    // You can't hold or transfer a call they're holding.
    expect(deviceStep(state, act("hold")).send).toEqual([]);
    expect(soundFor(run([active("c1")], state).state)).toBe("none");
  });

  it("blind transfer: MENU → Transfer, then a key", () => {
    const pending = run([...inCall, act("transfer")]);
    expect(pending.sent.at(-1)).not.toMatchObject({ t: "call.transfer" });
    const t = run([button(4)], pending.state);
    expect(t.sent).toEqual([{ t: "call.transfer", callId: "c1", to: { button: 4 } }]);
    // The server ends our side.
    expect(run([ended("c1")], t.state).state).toEqual({ kind: "offhook", lastEnd: "hangup" });
  });

  it("attended transfer connects the two others", () => {
    const { state } = run([
      ...inCall,
      act("hold"),
      button(1),
      callState("c2", "ringing"),
      active("c2"),
    ]);
    expect(deviceStep(state, act("transfer")).send).toEqual([
      { t: "call.transfer", callId: "c1", toCall: "c2" },
    ]);
  });

  it("being transferred: the call goes on under a new id (ringing for a blind transfer)", () => {
    const blind = run([
      ...inCall,
      ended("c1", { transfer: { callId: "c9", ringing: true, offerer: true } }),
    ]);
    expect(blind.state).toEqual({ kind: "dialing", button: -1, callId: "c9" });
    const attended = run([
      ...inCall,
      ended("c1", { transfer: { callId: "c9", ringing: false, offerer: false } }),
    ]);
    expect(attended.state).toEqual({ kind: "incall", callId: "c9", connected: false });
  });
});

describe("rooms on a phone", () => {
  const roomState = (roomId: string, muted = false): DeviceInput => ({
    type: "server",
    msg: {
      t: "room.state",
      roomId,
      name: "Party line",
      kind: "party",
      you: "p1",
      locked: false,
      media: "sfu",
      e2ee: false,
      participants: [{ id: "p1", name: "Kid", muted }],
    },
  });

  it("a speed-dial key joins a room; any key says still here; mute from MENU", () => {
    const { state } = run([hook("up"), button(2), roomState("r1")]);
    expect(state).toEqual({ kind: "inroom", roomId: "r1", muted: false });
    expect(deviceStep(state, button(5)).send).toEqual([{ t: "room.here", roomId: "r1" }]);
    const muted = deviceStep(state, { type: "action", action: "mute" });
    expect(muted.send).toEqual([{ t: "room.mute", roomId: "r1", muted: true }]);
    expect(muted.state).toMatchObject({ muted: true });
  });

  it("a refused join sounds busy; being dropped returns to dial tone", () => {
    const refused = run([
      hook("up"),
      button(2),
      { type: "server", msg: { t: "room.ended", reason: "locked" } },
    ]);
    expect(refused.state).toEqual({ kind: "offhook", lastEnd: "denied" });
    expect(soundFor(refused.state)).toBe("busy");
    const dropped = run([
      hook("up"),
      button(2),
      roomState("r1"),
      { type: "server", msg: { t: "room.ended", roomId: "r1", reason: "idle" } },
    ]);
    expect(dropped.state).toEqual({ kind: "offhook", lastEnd: "hangup" });
  });

  it("leaves a room it didn't expect (the handset went down while joining)", () => {
    const { sent } = run([hook("up"), button(2), hook("down"), roomState("r1")]);
    expect(sent.at(-1)).toEqual({ t: "room.leave", roomId: "r1" });
  });
});
