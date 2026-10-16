import { describe, expect, it } from "vitest";
import type { ServerSettings } from "./api.ts";
import { fairUseText, featureWords, serverRows } from "./serverText.ts";

const base: ServerSettings = {
  version: { server: "0.9.0", protocol: { min: 1, max: 1 }, federation: [1] },
  signup: { open: false, turnstile: false },
  addons: false,
  fairUse: null,
  calls: { turn: false, rooms: "mesh" },
  transcription: false,
  recording: { spacesMayRecord: true, refuseOtherServersRecordedCalls: false },
  publicUrl: null,
  federation: { on: false, fingerprint: null, features: [] },
  funding: null,
  sponsorUrl: null,
  operators: [],
  trustProxy: false,
  limits: {},
};
const row = (s: ServerSettings, label: string) => serverRows(s).find((r) => r.label === label);

describe("serverRows (the operator's This server card)", () => {
  it("has a row for every setting, in plain words", () => {
    const labels = serverRows(base).map((r) => r.label);
    for (const l of [
      "Version",
      "Sign-up",
      "Bot check on sign-up",
      "Add-ons",
      "Fair use",
      "Call relay (TURN)",
      "Rooms' audio",
      "Transcripts",
      "Call recording",
      "Calls other servers record",
      "Public address",
      "Federation",
      "Funding shown",
      "Sponsor button",
      "Operators",
      "Behind a proxy",
    ]) {
      expect(labels).toContain(l);
    }
    for (const r of serverRows(base)) expect(r.meaning.length).toBeGreaterThan(0);
  });

  it("says what's off, and what's on", () => {
    expect(row(base, "Sign-up")?.value).toBe("Invite only");
    expect(row(base, "Add-ons")?.value).toBe("Off");
    expect(row(base, "Call relay (TURN)")?.value).toBe("Not set up");
    expect(row(base, "Rooms' audio")?.value).toBe("Direct between people");
    const on: ServerSettings = {
      ...base,
      signup: { open: true, turnstile: true },
      addons: true,
      calls: { turn: true, rooms: "livekit" },
      federation: { on: true, fingerprint: "SHA256:x", features: ["rooms", "new-thing"] },
      operators: [
        { handle: "jesse", name: "Jesse" },
        { handle: null, name: null },
      ],
      limits: { keyPages: 3 },
    };
    expect(row(on, "Sign-up")?.value).toBe("Open to anyone");
    expect(row(on, "Bot check on sign-up")?.value).toBe("On");
    expect(row(on, "Add-ons")?.value).toBe("On");
    expect(row(on, "Call relay (TURN)")?.value).toBe("Set up");
    expect(row(on, "Rooms' audio")?.value).toBe("Through your LiveKit server");
    expect(row(on, "Offered to other servers")?.value).toBe("rooms with other servers, new-thing");
    expect(row(on, "Operators")?.value).toBe("Jesse (@jesse), an unknown account");
    expect(row(on, "Changed limits")?.value).toBe("3 speed-dial pages per phone");
    // Federation off: nothing offered, so no such row.
    expect(row(base, "Offered to other servers")).toBeUndefined();
  });

  it("writes the fair-use allowance out, or Unlimited", () => {
    expect(fairUseText(null)).toBe("Unlimited");
    expect(fairUseText({})).toBe("Unlimited");
    expect(fairUseText({ callMinutesPerMonth: 1000, phonesPerSpace: 5 })).toBe(
      "1,000 call minutes a month, 5 phones per space",
    );
    expect(featureWords("addons")).toBe("add-ons");
  });
});
