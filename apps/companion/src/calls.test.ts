import { describe, expect, it } from "vitest";
import { type CallEvent, type CallView, callStep, canLeaveVoicemail, toneFor } from "./calls.ts";

const idle: CallView = { phase: "idle" };
const state = (
  callId: string,
  s: "ringing" | "connecting" | "active" | "ended",
  reason?: "denied" | "hangup",
): CallEvent => ({
  type: "server",
  now: 1000,
  msg: { t: "call.state", callId, state: s, ...(reason ? { reason } : {}) },
});
const ringing = (callId: string, label = "Kid phone"): CallEvent => ({
  type: "server",
  now: 1000,
  msg: { t: "call.ringing", callId, from: { label } },
});

function run(events: CallEvent[], start: CallView = idle) {
  let view = start;
  const declined: string[] = [];
  for (const e of events) {
    const r = callStep(view, e);
    view = r.view;
    if (r.decline) declined.push(r.decline);
  }
  return { view, declined };
}

describe("outgoing", () => {
  it("adopts the call id from the first state and becomes the offerer", () => {
    const { view } = run([
      { type: "dial", label: "Kid phone" },
      state("c1", "ringing"),
      state("c1", "connecting"),
    ]);
    expect(view).toEqual({ phase: "connecting", callId: "c1", label: "Kid phone", offerer: true });
  });

  it("plays ringback only once the far end is ringing", () => {
    const dialing = run([{ type: "dial", label: "K" }]).view;
    expect(toneFor(dialing)).toBe("none");
    expect(toneFor(run([state("c1", "ringing")], dialing).view)).toBe("ringback");
  });

  it("shows why a refused call ended", () => {
    const { view } = run([{ type: "dial", label: "K" }, state("c9", "ended", "denied")]);
    expect(view).toEqual({ phase: "ended", label: "K", reason: "denied" });
  });

  it("goes active with a start time and ignores other calls' states", () => {
    const { view } = run([
      { type: "dial", label: "K" },
      state("c1", "ringing"),
      state("c2", "ended"),
      state("c1", "connecting"),
      state("c1", "active"),
    ]);
    expect(view).toMatchObject({ phase: "active", callId: "c1", offerer: true, startedAt: 1000 });
  });
});

describe("incoming", () => {
  it("rings, answers as the non-offerer, and connects", () => {
    let { view } = run([ringing("c1")]);
    expect(view).toEqual({ phase: "incoming", callId: "c1", label: "Kid phone" });
    expect(toneFor(view)).toBe("ring");
    view = run([{ type: "answer" }, state("c1", "connecting"), state("c1", "active")], view).view;
    expect(view).toMatchObject({ phase: "active", offerer: false });
  });

  it("vanishes when answered on another session", () => {
    expect(run([ringing("c1"), state("c1", "ended", "hangup")]).view).toEqual(idle);
  });

  it("declines a second call while busy", () => {
    const { view, declined } = run([ringing("c1"), ringing("c2")]);
    expect(view).toMatchObject({ callId: "c1" });
    expect(declined).toEqual(["c2"]);
  });

  it("does not decline a duplicate ringing for the same call", () => {
    expect(run([ringing("c1"), ringing("c1")]).declined).toEqual([]);
  });
});

describe("local actions", () => {
  it("hangup ends and dismiss returns to idle", () => {
    const ended = run([ringing("c1"), { type: "hangup" }]).view;
    expect(ended).toEqual({ phase: "ended", label: "Kid phone", reason: "hangup" });
    expect(run([{ type: "dismiss" }], ended).view).toEqual(idle);
  });

  it("ignores dialing while in a call", () => {
    const busy = run([ringing("c1")]).view;
    expect(run([{ type: "dial", label: "X" }], busy).view).toBe(busy);
  });
});

describe("voicemail after a quiet-hours refusal", () => {
  const ended = (reason: "voicemail" | "busy", deviceId?: string) => {
    let view = callStep(
      { phase: "idle" },
      { type: "dial", label: "Kid", ...(deviceId ? { deviceId } : {}) },
    ).view;
    view = callStep(view, {
      type: "server",
      msg: { t: "call.state", callId: "c1", state: "ended", reason },
      now: 0,
    }).view;
    return view;
  };

  it("remembers the dialled phone so a message can be left", () => {
    const view = ended("voicemail", "dev_1");
    expect(view).toEqual({ phase: "ended", label: "Kid", reason: "voicemail", deviceId: "dev_1" });
    expect(canLeaveVoicemail(view)).toBe(true);
  });

  it("does not offer voicemail for other reasons or unknown phones", () => {
    expect(canLeaveVoicemail(ended("busy", "dev_1"))).toBe(false);
    expect(canLeaveVoicemail(ended("voicemail"))).toBe(false);
  });
});

describe("calls through connections", () => {
  it("keeps the connection for a voicemail, and the server's note for a refusal", () => {
    const { view } = run([
      { type: "dial", label: "Kid phone", deviceId: "dev_1", via: "con_1" },
      {
        type: "server",
        now: 1000,
        msg: { t: "call.state", callId: "c9", state: "ended", reason: "voicemail" },
      },
    ]);
    expect(view).toMatchObject({ phase: "ended", deviceId: "dev_1", via: "con_1" });
    expect(canLeaveVoicemail(view)).toBe(true);
    const refused = run([
      { type: "dial", label: "Bob", person: true, via: "con_2" },
      {
        type: "server",
        now: 1000,
        msg: {
          t: "call.state",
          callId: "c8",
          state: "ended",
          reason: "denied",
          note: "You've used this month's 1000 call minutes (fair use).",
        },
      },
    ]).view;
    expect(refused).toMatchObject({ phase: "ended", note: expect.stringMatching(/fair use/) });
  });
});
