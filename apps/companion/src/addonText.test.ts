import { describe, expect, it } from "vitest";
import {
  addonAddressProblem,
  addonNameProblem,
  addonPreview,
  isAddonAddress,
} from "./addonText.ts";

describe("add-on words", () => {
  it("names are like handles", () => {
    expect(addonNameProblem("Seat")).toBeUndefined();
    expect(addonNameProblem("notes-2")).toBeUndefined();
    expect(addonNameProblem("")).toMatch(/name/);
    expect(addonNameProblem("a")).toMatch(/2 to 30/);
    expect(addonNameProblem("my seat")).toMatch(/2 to 30/);
    expect(addonNameProblem("a+b")).toMatch(/2 to 30/);
  });

  it("previews the address on your account", () => {
    expect(addonPreview("jesse@hub.example", " Seat ")).toBe("jesse+seat@hub.example");
    expect(addonPreview("jesse@localhost:8787", "seat")).toBe("jesse+seat@localhost:8787");
    expect(addonPreview(undefined, "seat")).toBeUndefined();
    expect(addonPreview("jesse@hub.example", "x")).toBeUndefined();
  });

  it("tells an add-on's address from a person's", () => {
    expect(isAddonAddress("jesse+seat@hub.example")).toBe(true);
    expect(isAddonAddress("jesse@hub.example")).toBe(false);
    expect(isAddonAddress("device:dev_1@hub.example")).toBe(false);
  });

  it("checks an add-on address someone typed", () => {
    expect(addonAddressProblem(" Jesse+Seat@hub.example ")).toBeUndefined();
    expect(addonAddressProblem("jesse+seat@localhost:8787")).toBeUndefined();
    expect(addonAddressProblem("")).toMatch(/Type/);
    expect(addonAddressProblem("jesse@hub.example")).toMatch(/isn't an add-on/);
    expect(addonAddressProblem("jesse+@hub.example")).toMatch(/isn't an add-on/);
  });
});
