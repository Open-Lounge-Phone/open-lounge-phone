import { describe, expect, it } from "vitest";
import {
  afterMissedCallback,
  effectiveLimit,
  LINE_DEFAULTS,
  type LineBlocks,
  type LineCaller,
  type LineSettings,
  lineAdmits,
  lineEntry,
  maxWaitOutcome,
  mayLeaveVoicemailInstead,
  mayOfferCallback,
  noQueueOutcome,
  ordinal,
  queueAdmit,
  queueOrder,
  queuePositions,
} from "./lines.ts";

const on: LineSettings = { ...LINE_DEFAULTS, enabled: true };
const stranger: LineCaller = {
  address: "ann@far.example",
  host: "far.example",
  kidsPhone: false,
  member: false,
  connected: false,
};
const none: LineBlocks = { addresses: new Set(), servers: new Set() };

describe("who may call a public line", () => {
  it("is off until enabled", () => {
    expect(lineAdmits(LINE_DEFAULTS, stranger, none)).toEqual({ ok: false, why: "disabled" });
    expect(lineAdmits(on, stranger, none)).toEqual({ ok: true });
  });

  it("never a kids' phone, whatever the setting or membership", () => {
    for (const who of ["anyone", "connections", "allowlist"] as const) {
      const line = { ...on, who, allow: ["far.example"] };
      expect(lineAdmits(line, { ...stranger, kidsPhone: true, member: true }, none)).toEqual({
        ok: false,
        why: "kids",
      });
    }
  });

  it("blocked addresses and servers are refused (case-insensitive)", () => {
    const byAddress = { addresses: new Set(["ann@far.example"]), servers: new Set<string>() };
    const byServer = { addresses: new Set<string>(), servers: new Set(["far.example"]) };
    const loud = { ...stranger, address: "Ann@Far.Example", host: "FAR.example" };
    expect(lineAdmits(on, loud, byAddress)).toEqual({ ok: false, why: "blocked" });
    expect(lineAdmits(on, loud, byServer)).toEqual({ ok: false, why: "blocked" });
    expect(
      lineAdmits(on, { ...stranger, address: "bo@far2.example", host: "far2.example" }, byServer),
    ).toEqual({ ok: true });
  });

  it("connections only: members and people connected to a member", () => {
    const line = { ...on, who: "connections" as const };
    expect(lineAdmits(line, stranger, none)).toEqual({ ok: false, why: "not_allowed" });
    expect(lineAdmits(line, { ...stranger, connected: true }, none)).toEqual({ ok: true });
    expect(lineAdmits(line, { ...stranger, member: true }, none)).toEqual({ ok: true });
  });

  it("allow-list: servers or exact addresses", () => {
    const servers = { ...on, who: "allowlist" as const, allow: ["far.example"] };
    const people = { ...on, who: "allowlist" as const, allow: ["bo@far.example"] };
    expect(lineAdmits(servers, stranger, none)).toEqual({ ok: true });
    expect(lineAdmits(people, stranger, none)).toEqual({ ok: false, why: "not_allowed" });
    expect(lineAdmits(people, { ...stranger, address: "bo@far.example" }, none)).toEqual({
      ok: true,
    });
    // An empty allow-list lets nobody in from outside.
    expect(lineAdmits({ ...on, who: "allowlist" }, stranger, none).ok).toBe(false);
  });

  it("a line's own limits are stricter, never looser", () => {
    expect(effectiveLimit(10, null)).toBe(10);
    expect(effectiveLimit(10, 3)).toBe(3);
    expect(effectiveLimit(10, 50)).toBe(10);
  });
});

describe("the queue", () => {
  it("first come, first served, with stable positions", () => {
    const entries = [
      { callId: "c3", since: 30 },
      { callId: "c1", since: 10 },
      { callId: "c2", since: 10 },
    ];
    expect(queueOrder(entries).map((e) => e.callId)).toEqual(["c1", "c2", "c3"]);
    const pos = queuePositions(entries);
    expect(pos.get("c1")).toEqual({ position: 1, size: 3 });
    expect(pos.get("c3")).toEqual({ position: 3, size: 3 });
  });

  it("admits up to the longest line; off means no waiting at all", () => {
    expect(queueAdmit({ queue: true, queueMax: 2 }, 0)).toBe("queue");
    expect(queueAdmit({ queue: true, queueMax: 2 }, 1)).toBe("queue");
    expect(queueAdmit({ queue: true, queueMax: 2 }, 2)).toBe("full");
    expect(queueAdmit({ queue: false, queueMax: 2 }, 0)).toBe("off");
  });

  it("without a queue: voicemail if the line takes it, else the call ends", () => {
    expect(noQueueOutcome({ voicemail: true })).toBe("voicemail");
    expect(noQueueOutcome({ voicemail: false })).toBe("end");
  });

  it("at the longest wait: voicemail, overflow, or end; never voicemail when it's off", () => {
    expect(maxWaitOutcome(on, "g1")).toEqual({ kind: "voicemail" });
    expect(maxWaitOutcome({ ...on, voicemail: false }, "g1")).toEqual({ kind: "end" });
    const overflow = { ...on, atMaxWait: { kind: "group" as const, groupId: "g2" } };
    expect(maxWaitOutcome(overflow, "g1")).toEqual({ kind: "group", groupId: "g2" });
    // Overflowing into itself would loop: voicemail instead.
    expect(maxWaitOutcome(overflow, "g2")).toEqual({ kind: "voicemail" });
    const person = { ...on, atMaxWait: { kind: "user" as const, userId: "u1" } };
    expect(maxWaitOutcome({ ...person, voicemail: false }, "g1")).toEqual({
      kind: "user",
      userId: "u1",
    });
    const end = { ...on, atMaxWait: { kind: "end" as const, message: "Call back tomorrow" } };
    expect(maxWaitOutcome(end, "g1")).toEqual({ kind: "end", message: "Call back tomorrow" });
  });

  it("'leave a voicemail instead' needs voicemail on and the option on", () => {
    expect(mayLeaveVoicemailInstead(on)).toBe(true);
    expect(mayLeaveVoicemailInstead({ ...on, offerVoicemail: false })).toBe(false);
    expect(mayLeaveVoicemailInstead({ ...on, voicemail: false })).toBe(false);
  });
});

describe("call me back", () => {
  it("is offered only on a line with a queue and the option on", () => {
    expect(mayOfferCallback({ queue: true, callback: true })).toBe(true);
    expect(mayOfferCallback({ queue: true, callback: false })).toBe(false);
    expect(mayOfferCallback({ queue: false, callback: true })).toBe(false);
    expect(LINE_DEFAULTS).toMatchObject({ callback: true, callbackMissed: "retry" });
  });

  it("a missed call back: one retry, then voicemail (or nothing without voicemail)", () => {
    const retry = { callbackMissed: "retry" as const, voicemail: true };
    expect(afterMissedCallback(retry, 1)).toBe("retry");
    expect(afterMissedCallback(retry, 2)).toBe("voicemail");
    expect(afterMissedCallback({ ...retry, voicemail: false }, 2)).toBe("drop");
    const vm = { callbackMissed: "voicemail" as const, voicemail: true };
    expect(afterMissedCallback(vm, 1)).toBe("voicemail");
    expect(afterMissedCallback({ ...vm, voicemail: false }, 1)).toBe("drop");
  });
});

describe("words and entries", () => {
  it("ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
      "111th",
    ]);
  });

  it("allow-list and blocklist entries: a server or an address", () => {
    expect(lineEntry(" Far.Example ")).toEqual({ kind: "server", value: "far.example" });
    expect(lineEntry("@Ann@far.example:8443")).toEqual({
      kind: "address",
      value: "ann@far.example:8443",
    });
    expect(lineEntry("not a host")).toBeUndefined();
    expect(lineEntry("a@b@c")).toBeUndefined();
  });
});
