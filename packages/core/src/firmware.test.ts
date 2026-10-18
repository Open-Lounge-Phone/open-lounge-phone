import { describe, expect, it } from "vitest";
import { buildLabel, firmwareChange } from "./firmware.ts";

const a = "a".repeat(64);
const b = "b".repeat(64);
const home = { sha256: b, project: "mia-snake", version: "2", official: false };
const update = { sha256: b, project: "openloungephone", version: "0.9.8", official: true };
const kids = { model: "esp32s3", kids: true, askFirst: true };

describe("firmwareChange", () => {
  it("records the first build quietly, and nothing when the image is the same", () => {
    expect(firmwareChange(undefined, home, kids)).toEqual({ kind: "first" });
    expect(firmwareChange({ sha256: b }, home, kids)).toEqual({ kind: "none" });
  });

  it("a kids' phone on a home build: tell the guardians; hold it only with Ask me first", () => {
    expect(firmwareChange({ sha256: a }, home, kids)).toEqual({
      kind: "changed",
      notify: true,
      hold: true,
    });
    expect(firmwareChange({ sha256: a }, home, { ...kids, askFirst: false })).toEqual({
      kind: "changed",
      notify: true,
      hold: false,
    });
  });

  it("an official update is only logged", () => {
    expect(firmwareChange({ sha256: a }, update, kids)).toEqual({ kind: "official" });
  });

  it("other phones: logged, never an alert or a hold", () => {
    expect(firmwareChange({ sha256: a }, home, { ...kids, kids: false })).toEqual({
      kind: "changed",
      notify: false,
      hold: false,
    });
  });

  it("browser phones and add-ons are never tracked", () => {
    for (const model of ["web-emulator", "addon"]) {
      expect(firmwareChange({ sha256: a }, home, { ...kids, model })).toEqual({ kind: "none" });
      expect(firmwareChange(undefined, home, { ...kids, model })).toEqual({ kind: "none" });
    }
  });

  it("a hardware phone that reports no build is ignored", () => {
    expect(firmwareChange({ sha256: a }, undefined, kids)).toEqual({ kind: "none" });
    expect(firmwareChange(undefined, undefined, kids)).toEqual({ kind: "none" });
  });
});

describe("buildLabel", () => {
  it("shows only the version of our own images, and the project of anyone else's", () => {
    expect(buildLabel(update)).toBe("0.9.8");
    expect(buildLabel(home)).toBe("mia-snake 2");
  });
});
