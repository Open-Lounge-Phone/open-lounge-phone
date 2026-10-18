import { describe, expect, it } from "vitest";
import { buildOrigin, firmwareNotice, phoneOf } from "./firmwareText.ts";

describe("firmware notice", () => {
  const at = new Date(2026, 9, 18, 16, 12).getTime();
  it("says whose phone, what it runs and when, in plain words", () => {
    expect(
      firmwareNotice(
        { name: "Mia", project: "mia-snake", version: "2", held: false, at },
        at + 60_000,
        "en-US",
      ),
    ).toBe("Mia's phone is running new firmware: built at home, 'mia-snake 2', today 4:12 PM.");
  });
  it("says it's waiting when Ask me first held it", () => {
    expect(
      firmwareNotice(
        { name: "Kid phone", project: "openloungephone", version: "0.9.8-dev", held: true, at },
        at,
        "en-US",
      ),
    ).toBe(
      "Kid phone is running new firmware: built at home, '0.9.8-dev', today 4:12 PM. It can't make or take calls until you OK it.",
    );
  });
  it("names phones and origins", () => {
    expect(phoneOf("Desk phone")).toBe("Desk phone");
    expect(buildOrigin(true)).toBe("Official update");
  });
});
