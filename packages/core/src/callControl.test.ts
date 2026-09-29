import { describe, expect, it } from "vitest";
import { controlCheck, type PartyCall } from "./callControl.ts";

const live = (callId: string, heldBy?: "me" | "other"): PartyCall => ({
  callId,
  phase: "active",
  ...(heldBy ? { heldBy } : {}),
});

describe("call control: hold, consult, merge, transfer", () => {
  it("dials with no call, or as a consult while the only other call is on hold by you", () => {
    expect(controlCheck([], { type: "dial" }).ok).toBe(true);
    expect(controlCheck([live("a", "me")], { type: "dial" }).ok).toBe(true);
    expect(controlCheck([live("a")], { type: "dial" }).ok).toBe(false);
    expect(controlCheck([live("a", "other")], { type: "dial" }).ok).toBe(false);
    expect(controlCheck([live("a", "me"), live("b")], { type: "dial" }).ok).toBe(false);
  });

  it("holds an answered call, one at a time, and never one they're holding", () => {
    expect(controlCheck([live("a")], { type: "hold", callId: "a", hold: true }).ok).toBe(true);
    expect(
      controlCheck([{ callId: "a", phase: "ringing" }], { type: "hold", callId: "a", hold: true })
        .ok,
    ).toBe(false);
    expect(controlCheck([live("a", "other")], { type: "hold", callId: "a", hold: true }).ok).toBe(
      false,
    );
    expect(
      controlCheck([live("a", "me"), live("b")], { type: "hold", callId: "b", hold: true }).ok,
    ).toBe(false);
  });

  it("resumes your held call only once the consult call is gone", () => {
    expect(controlCheck([live("a", "me")], { type: "hold", callId: "a", hold: false }).ok).toBe(
      true,
    );
    expect(
      controlCheck([live("a", "me"), live("b")], { type: "hold", callId: "a", hold: false }).ok,
    ).toBe(false);
    expect(controlCheck([live("a", "other")], { type: "hold", callId: "a", hold: false }).ok).toBe(
      false,
    );
  });

  it("merges or transfers (attended) your held call with the live consult call", () => {
    const calls = [live("a", "me"), live("b")];
    for (const type of ["merge", "transfer-attended"] as const) {
      expect(controlCheck(calls, { type, held: "a", active: "b" }).ok).toBe(true);
      expect(controlCheck(calls, { type, held: "b", active: "a" }).ok).toBe(false);
      expect(controlCheck(calls, { type, held: "a", active: "a" }).ok).toBe(false);
      expect(controlCheck([live("a"), live("b")], { type, held: "a", active: "b" }).ok).toBe(false);
      expect(
        controlCheck([live("a", "me"), { callId: "b", phase: "ringing" }], {
          type,
          held: "a",
          active: "b",
        }).ok,
      ).toBe(false);
    }
  });

  it("transfers (blind) an answered call, not one they're holding", () => {
    expect(controlCheck([live("a")], { type: "transfer", callId: "a" }).ok).toBe(true);
    expect(controlCheck([live("a", "me")], { type: "transfer", callId: "a" }).ok).toBe(true);
    expect(controlCheck([live("a", "other")], { type: "transfer", callId: "a" }).ok).toBe(false);
    expect(controlCheck([], { type: "transfer", callId: "a" }).ok).toBe(false);
  });
});
