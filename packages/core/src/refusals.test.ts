import { describe, expect, it } from "vitest";
import {
  ADDON_OFFLINE_NOTE,
  CALLER_BUSY_NOTE,
  CANT_CALL_NOTE,
  REFUSAL_NOTES,
  refusalStatus,
} from "./refusals.ts";

describe("refusal notes on phones", () => {
  it("gives each a short line that fits the strip", () => {
    for (const note of REFUSAL_NOTES) {
      const lines = refusalStatus(note);
      expect(lines).toBeDefined();
      for (const l of lines ?? []) expect(l.length).toBeLessThanOrEqual(16);
      expect(note.length).toBeLessThanOrEqual(200);
    }
    expect(refusalStatus(CALLER_BUSY_NOTE)?.[0]).toBe("ON ANOTHER CALL");
    expect(refusalStatus(ADDON_OFFLINE_NOTE)?.[0]).toBe("ADD-ON OFFLINE");
    expect(refusalStatus(CANT_CALL_NOTE)?.[0]).toBe("CAN'T CALL THAT");
  });

  it("knows nothing of other notes", () => {
    expect(refusalStatus(undefined)).toBeUndefined();
    expect(refusalStatus("Something else")).toBeUndefined();
  });
});
