import { CONNECTION_LOST_NOTE } from "@openloungephone/core";
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

  it("call waiting: offered while talking, never while ringing or calling", () => {
    const talking = run([ringing("c1"), { type: "answer" }, state("c1", "active")]).view;
    const waiting: CallEvent = {
      type: "server",
      now: 1000,
      msg: { t: "call.ringing", callId: "c2", from: { label: "Ana" }, waiting: true },
    };
    expect(callStep(talking, waiting)).toEqual({
      view: talking,
      waiting: { callId: "c2", label: "Ana" },
    });
    // Still ringing ourselves: a second call is declined, as before.
    expect(callStep(run([ringing("c1")]).view, waiting).decline).toBe("c2");
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

  it("a lost connection ends a live call, saying why; nothing else is lost", () => {
    const live = run([ringing("c1"), { type: "answer" }, state("c1", "active")]).view;
    expect(run([{ type: "lost" }], live).view).toEqual({
      phase: "ended",
      label: "Kid phone",
      reason: "error",
      note: CONNECTION_LOST_NOTE,
    });
    const ringingView = run([ringing("c1")]).view;
    expect(run([{ type: "lost" }], ringingView).view).toBe(ringingView);
  });

  it("ignores dialing while in a call", () => {
    const busy = run([ringing("c1")]).view;
    expect(run([{ type: "dial", label: "X" }], busy).view).toBe(busy);
  });
});

describe("voicemail after an unanswered call", () => {
  const offer = {
    ticket: "t".repeat(43),
    name: "Kid",
    maxMs: 120_000,
    prompts: [
      "name" as const,
      "vm.cant_take" as const,
      "vm.leave_message" as const,
      "vm.tone" as const,
    ],
  };
  const ended = (reason: "voicemail" | "timeout" | "denied", withOffer: boolean) => {
    let view = callStep({ phase: "idle" }, { type: "dial", label: "Kid", person: true }).view;
    view = callStep(view, {
      type: "server",
      msg: {
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason,
        ...(withOffer ? { voicemail: offer } : {}),
      },
      now: 0,
    }).view;
    return view;
  };

  it("keeps the server's offer so a message can be left, for any callee", () => {
    const view = ended("timeout", true);
    expect(view).toMatchObject({ phase: "ended", reason: "timeout", voicemail: offer });
    expect(canLeaveVoicemail(view)).toBe(true);
    expect(canLeaveVoicemail(ended("voicemail", true))).toBe(true);
  });

  it("offers nothing without the server's offer", () => {
    expect(canLeaveVoicemail(ended("voicemail", false))).toBe(false);
    expect(canLeaveVoicemail(ended("denied", false))).toBe(false);
  });

  it("an incoming call that ends never offers voicemail to the callee", () => {
    let view = callStep(
      { phase: "idle" },
      {
        type: "server",
        msg: { t: "call.ringing", callId: "c2", from: { label: "Mom" } },
        now: 0,
      },
    ).view;
    view = callStep(view, { type: "answer" }).view;
    view = callStep(view, {
      type: "server",
      msg: { t: "call.state", callId: "c2", state: "ended", reason: "hangup", voicemail: offer },
      now: 0,
    }).view;
    expect(canLeaveVoicemail(view)).toBe(false);
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
    expect(canLeaveVoicemail(view)).toBe(false); // no offer from the server: nothing to leave
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

describe("hold, merge and transfer", () => {
  const active = callStep(
    { phase: "connecting", callId: "c1", label: "Gran", offerer: true },
    { type: "server", msg: { t: "call.state", callId: "c1", state: "active" }, now: 5 },
  ).view;

  it("shows who's holding and plays the soft tone when they hold you", () => {
    const held = callStep(active, {
      type: "server",
      msg: { t: "call.state", callId: "c1", state: "active", hold: "them" },
      now: 6,
    }).view;
    expect(held).toMatchObject({ phase: "active", hold: "them", startedAt: 5 });
    expect(toneFor(held)).toBe("hold");
    const back = callStep(held, {
      type: "server",
      msg: { t: "call.state", callId: "c1", state: "active" },
      now: 7,
    }).view;
    expect(back).not.toHaveProperty("hold");
    expect(toneFor(back)).toBe("none");
  });

  it("a merged call disappears quietly and names its room", () => {
    const step = callStep(active, {
      type: "server",
      msg: {
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason: "hangup",
        merged: { roomId: "r1" },
      },
      now: 8,
    });
    expect(step).toEqual({ view: { phase: "idle" }, merged: "r1" });
  });

  it("a transferred call goes on under its new id", () => {
    const blind = callStep(active, {
      type: "server",
      msg: {
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason: "hangup",
        transfer: { callId: "c2", ringing: true, offerer: true },
      },
      now: 8,
    });
    expect(blind.transferred).toBe("c1");
    expect(blind.view).toMatchObject({ phase: "outgoing", callId: "c2", ringing: true });
    const attended = callStep(active, {
      type: "server",
      msg: {
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason: "hangup",
        transfer: { callId: "c3", ringing: false, offerer: false },
      },
      now: 8,
    });
    expect(attended.view).toEqual({
      phase: "connecting",
      callId: "c3",
      label: "Gran",
      offerer: false,
    });
  });
});

describe("recording notices", () => {
  it("marks the call recorded (sticky across hold changes)", () => {
    const active: CallView = { phase: "active", callId: "c", label: "Ben", offerer: true };
    const msg = (extra: object) => ({
      type: "server" as const,
      now: 1,
      msg: { t: "call.state" as const, callId: "c", state: "active" as const, ...extra },
    });
    const rec = callStep(active, msg({ recording: { by: "Acme" } })).view;
    expect(rec).toMatchObject({ phase: "active", recording: "Acme" });
    const held = callStep(rec, msg({ hold: "them" })).view;
    expect(held).toMatchObject({ hold: "them", recording: "Acme" });
    // A second notice changes nothing.
    expect(callStep(rec, msg({ recording: { by: "Acme" } })).view).toBe(rec);
  });
});

describe("public lines", () => {
  const line = { name: "Acme support", address: "help@acme.example" };
  const ev = (msg: Extract<CallEvent, { type: "server" }>["msg"]): CallEvent => ({
    type: "server",
    now: 1000,
    msg,
  });

  it("shows the line's name, the caller's place in line, then ringing again", () => {
    const steps = [
      { type: "dial", label: "help@acme.example", person: true } as CallEvent,
      ev({ t: "call.state", callId: "c1", state: "ringing" }),
      ev({ t: "call.state", callId: "c1", state: "ringing", line }),
      ev({
        t: "call.state",
        callId: "c1",
        state: "ringing",
        queue: { position: 2, size: 3, voicemail: true },
      }),
    ];
    const queued = run(steps).view;
    expect(queued).toMatchObject({
      phase: "outgoing",
      label: "Acme support",
      line,
      queue: { position: 2, size: 3, voicemail: true },
    });
    expect(toneFor(queued)).toBe("hold");
    const again = run([...steps, ev({ t: "call.state", callId: "c1", state: "ringing" })]).view;
    expect(again).toMatchObject({ phase: "outgoing", label: "Acme support", ringing: true });
    expect(again).not.toHaveProperty("queue");
    expect(toneFor(again)).toBe("ringback");
  });

  it("members see who calls the line, with their verified address", () => {
    const { view } = run([
      ev({
        t: "call.ringing",
        callId: "c2",
        from: { label: "Ann", address: "ann@far.example" },
        line,
      }),
    ]);
    expect(view).toEqual({
      phase: "incoming",
      callId: "c2",
      label: "Ann",
      address: "ann@far.example",
      line: "Acme support",
    });
  });

  it("call me back: the place is kept; the line calls back; answering goes on as a new call", () => {
    const waiting = run([
      { type: "dial", label: "help@acme.example", person: true },
      ev({ t: "call.state", callId: "c1", state: "ringing", line }),
      ev({
        t: "call.state",
        callId: "c1",
        state: "ringing",
        queue: { position: 3, callback: true },
      }),
    ]).view;
    expect(waiting).toMatchObject({ queue: { position: 3, callback: true } });
    const kept = callStep(
      waiting,
      ev({
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason: "hangup",
        callback: { until: 5000 },
      }),
    ).view;
    expect(kept).toMatchObject({ phase: "ended", label: "Acme support", callbackUntil: 5000 });
    const back = run([
      ev({
        t: "call.ringing",
        callId: "c1",
        from: { label: "Acme support", address: "help@acme.example" },
        callback: line,
      }),
    ]).view;
    expect(back).toMatchObject({ phase: "incoming", callback: true, label: "Acme support" });
    const answered = callStep(back, { type: "answer" }).view;
    const step = callStep(
      answered,
      ev({
        t: "call.state",
        callId: "c1",
        state: "ended",
        reason: "hangup",
        transfer: { callId: "c2", ringing: true, offerer: true },
      }),
    );
    expect(step.transferred).toBe("c1");
    expect(step.view).toMatchObject({ phase: "outgoing", callId: "c2", ringing: true });
    // Missed, with the line's voicemail offer: leave a message.
    const offer = { ticket: "t1-ticket-123456789", name: "Support", maxMs: 120_000, prompts: [] };
    const missed = callStep(
      back,
      ev({ t: "call.state", callId: "c1", state: "ended", reason: "timeout", voicemail: offer }),
    ).view;
    expect(missed).toMatchObject({ phase: "ended", voicemail: offer });
  });
});

describe("add-ons", () => {
  it("an add-on's call keeps its add-on mark from ringing to active", () => {
    const addonRing: CallEvent = {
      type: "server",
      now: 1000,
      msg: {
        t: "call.ringing",
        callId: "c1",
        from: { label: "seat", address: "jo+seat@x.example", kind: "addon" },
      },
    };
    let { view } = run([addonRing]);
    expect(view).toMatchObject({ phase: "incoming", addon: true, address: "jo+seat@x.example" });
    view = run([{ type: "answer" }, state("c1", "connecting"), state("c1", "active")], view).view;
    expect(view).toMatchObject({ phase: "active", addon: true });
    expect(run([ringing("c2")]).view).not.toHaveProperty("addon");
  });

  it("an add-on calling within a share shows the share with its name", () => {
    const { view } = run([
      {
        type: "server",
        now: 1000,
        msg: {
          t: "call.ringing",
          callId: "c1",
          from: {
            label: "seat",
            address: "jo+seat+bookclub@x.example",
            kind: "addon",
            share: "Book club",
          },
        },
      },
    ]);
    expect(view).toMatchObject({ phase: "incoming", label: "seat · Book club", addon: true });
  });

  it("calling one marks the call as with an add-on until it ends", () => {
    const { view } = run([
      { type: "dial", label: "seat", person: true, addon: true },
      state("c1", "ringing"),
      state("c1", "connecting"),
      state("c1", "active"),
    ]);
    expect(view).toMatchObject({ phase: "active", addon: true, offerer: true });
    expect(run([state("c1", "ended", "hangup")], view).view).toMatchObject({
      phase: "ended",
      addon: true,
    });
  });
});
