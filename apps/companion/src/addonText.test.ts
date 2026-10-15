import { describe, expect, it } from "vitest";
import {
  addonAddressProblem,
  addonCallLabel,
  addonNameProblem,
  addonPreview,
  heldShareLabel,
  isAddonAddress,
  shareRequestText,
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
    // A share's address.
    expect(addonAddressProblem("jesse+seat+book-club@hub.example")).toBeUndefined();
    expect(addonAddressProblem("jesse+seat+Book Club@hub.example")).toMatch(/isn't an add-on/);
    expect(isAddonAddress("jesse+seat+bookclub@hub.example")).toBe(true);
  });

  it("names shares", () => {
    expect(addonCallLabel("seat")).toBe("seat");
    expect(addonCallLabel("seat", "Book club")).toBe("seat · Book club");
    expect(heldShareLabel("Jesse", "seat", "Book club")).toBe("Jesse's seat · Book club");
  });

  it("says where a share request stands", () => {
    const r = { label: "Book club", people: ["Ana", "Bob"] };
    expect(shareRequestText("seat", { ...r, state: "waiting" })).toBe(
      "Asking seat to make Book club…",
    );
    expect(shareRequestText("seat", { ...r, state: "created" })).toBe(
      "Done. Book club is shared with Ana, Bob.",
    );
    expect(shareRequestText("seat", { ...r, state: "refused", reason: "Not now." })).toBe(
      "seat didn't make it: Not now.",
    );
    expect(shareRequestText("seat", { ...r, state: "offline" })).toMatch(/offline/);
    expect(shareRequestText("seat", { ...r, state: "timeout" })).toMatch(/didn't answer/);
  });
});
