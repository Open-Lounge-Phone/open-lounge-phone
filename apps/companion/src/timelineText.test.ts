import { describe, expect, it } from "vitest";
import { callLine, inheritedRetention, retentionOptions } from "./timelineText.ts";

const call = (over: Partial<Parameters<typeof callLine>[0]>) => ({
  kind: "call" as const,
  id: "cl_1",
  at: 0,
  direction: "in" as const,
  answered: false,
  durationMs: 0,
  endReason: "timeout",
  voicemail: null,
  ...over,
});

describe("timeline wording", () => {
  it("says which way a call went and how long it lasted", () => {
    expect(callLine(call({ answered: true, durationMs: 185_000 }))).toBe("Incoming call · 3:05");
    expect(callLine(call({ direction: "out", answered: true, durationMs: 60_000 }))).toBe(
      "Outgoing call · 1:00",
    );
    expect(callLine(call({}))).toBe("Missed call");
    expect(callLine(call({ endReason: "declined" }))).toBe("Declined call");
    expect(callLine(call({ direction: "out", endReason: "busy" }))).toBe(
      "Call not answered (busy)",
    );
    expect(callLine(call({ direction: "out", endReason: "hangup" }))).toBe("Call cancelled");
  });

  it("explains what the default retention is", () => {
    expect(inheritedRetention("default")).toBe("forever");
    expect(inheritedRetention("30d")).toBe("30d");
    expect(retentionOptions("1y", "Account default")[0]).toEqual({
      value: "default",
      label: "Account default (1 year)",
    });
    expect(retentionOptions("forever", "Server default").map((o) => o.value)).toEqual([
      "default",
      "30d",
      "1y",
      "forever",
    ]);
  });
});
