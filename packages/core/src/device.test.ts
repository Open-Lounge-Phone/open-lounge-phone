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
