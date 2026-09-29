import { describe, expect, it } from "vitest";
import { goesToVoicemail, greetingScript, greetingText } from "./voicemail.ts";

describe("voicemail", () => {
  it("offers voicemail for unanswered calls only", () => {
    for (const r of ["timeout", "declined", "busy", "voicemail", "unavailable", "unreachable"]) {
      expect(goesToVoicemail(r as never), r).toBe(true);
    }
    for (const r of ["denied", "hangup", "error"])
      expect(goesToVoicemail(r as never), r).toBe(false);
  });

  it("speaks the default greeting with the name", () => {
    expect(greetingScript("default", "Grandma")).toEqual([
      { kind: "say", text: "Grandma can't take your call. Leave a message after the tone." },
      { kind: "tone" },
    ]);
  });

  it("puts a recorded name into the default sentence", () => {
    expect(greetingScript("name", "Grandma")).toEqual([
      { kind: "audio" },
      { kind: "say", text: "can't take your call. Leave a message after the tone." },
      { kind: "tone" },
    ]);
  });

  it("plays a custom greeting as it is, then the tone", () => {
    expect(greetingScript("custom", "Grandma")).toEqual([{ kind: "audio" }, { kind: "tone" }]);
    expect(greetingText("custom", "x")).toBe("(their own greeting)");
  });
});
