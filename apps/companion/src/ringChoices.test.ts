import { describe, expect, it } from "vitest";
import { ringChoices } from "./GreetingEditor.tsx";

describe("ring time choices", () => {
  it("shows the saved value even when it isn't a usual choice", () => {
    expect(ringChoices(35)).toContain(35);
    expect(ringChoices(35).indexOf(35)).toBe(ringChoices(35).indexOf(40) - 1);
    expect(ringChoices(20)).toEqual([10, 15, 20, 25, 30, 40, 50, 60]);
  });
});
