import { describe, expect, it } from "vitest";
import { afterHoursText, auditText, hoursText, queueText } from "./workplaceText.ts";

describe("public line words", () => {
  it("the caller's place in line", () => {
    expect(queueText({ position: 1, size: 3 })).toBe("You're next in line");
    expect(queueText({ position: 2, size: 3 })).toBe("You're 2nd in line");
    expect(queueText({ position: 23 })).toBe("You're 23rd in line");
    expect(queueText({ voicemail: true })).toBe("Waiting in line");
  });
  it("audit entries", () => {
    expect(auditText("line.enable", { address: "help@acme.example" })).toBe(
      "made help@acme.example public (confirmed the warning)",
    );
    expect(auditText("line.block", { value: "far.example" })).toBe(
      "blocked far.example from the public lines",
    );
  });
});

describe("workplace words", () => {
  it("hours", () => {
    expect(hoursText(null)).toBe("always open");
    expect(hoursText([{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }])).toBe(
      "Mon–Fri 09:00–17:00",
    );
    expect(hoursText([{ days: [6, 0], start: "10:00", end: "14:00" }])).toBe(
      "Sun, Sat 10:00–14:00",
    );
  });
  it("after hours", () => {
    const dir = { groups: [{ id: "g", name: "Night" }], members: [{ id: "u", name: "Ada" }] };
    // biome-ignore lint/suspicious/noExplicitAny: minimal directory
    const d = dir as any;
    expect(afterHoursText(null, d)).toBe("as the space says");
    expect(afterHoursText({ kind: "voicemail" }, d)).toBe("voicemail");
    expect(afterHoursText({ kind: "group", groupId: "g" }, d)).toBe("forward to Night");
    expect(afterHoursText({ kind: "user", userId: "u" }, d)).toBe("forward to Ada");
  });
  it("audit", () => {
    expect(auditText("extension.set", { number: "201" })).toBe("set extension 201");
    expect(auditText("role.change", { name: "Ben", role: "admin" })).toBe("made Ben an admin");
    expect(auditText("recording.update", { enabled: true })).toBe("turned call recording on");
    expect(auditText("something.new", null)).toBe("something.new");
  });
});
