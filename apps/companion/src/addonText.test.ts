import { describe, expect, it } from "vitest";
import {
  aboutLines,
  addonAddressProblem,
  addonCallLabel,
  addonNameProblem,
  addonPreview,
  addonStatus,
  addonTestText,
  firstFreeSlot,
  goneText,
  heldShareLabel,
  isAddonAddress,
  learnsText,
  linkedText,
  removalText,
  shareRequestText,
  stoppedText,
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

describe("what an add-on does, in words", () => {
  it("says only what it said, plainly; nothing about any particular add-on", () => {
    expect(aboutLines(null, "radio")).toEqual([
      "radio hasn't said what it does.",
      "You can call it, it may call you, and it can hear what you say.",
    ]);
    const radio = {
      hears: "nothing" as const,
      transcribes: true,
      answers: true,
      calls: false,
      shares: true,
      keys: false,
      lines: 5,
    };
    expect(aboutLines(radio, "radio")).toEqual([
      "You can call it.",
      "It never calls you.",
      "It only plays sound. It says it doesn't use what you say.",
      "It offers parts of itself to share with people you choose.",
      "It takes up to 5 calls at once.",
    ]);
    const notes = { ...radio, hears: "keeps" as const, calls: true, keys: true, lines: 1 };
    expect(aboutLines(notes, "notes")).toEqual([
      "You can call it.",
      "It may call you.",
      "It keeps what it hears: recordings, transcripts or notes.",
      "It turns what it hears into text.",
      "It responds to keys you press during a call.",
      "It offers parts of itself to share with people you choose.",
    ]);
  });

  it("says what it learns about callers, and where it stands", () => {
    expect(learnsText("echo")).toBe(
      "When you call, echo learns your name and address, and can hear what you say.",
    );
    expect(learnsText("echo", "Ana")).toBe(
      "When Ana calls, echo learns their name and address, and can hear what they say.",
    );
    const when = () => "5 min ago";
    expect(addonStatus({ online: true, lastSeen: 1 }, true, when)).toBe("Online");
    expect(addonStatus({ online: false, lastSeen: 1 }, true, when)).toBe(
      "Offline · last seen 5 min ago",
    );
    expect(addonStatus({ online: false, lastSeen: null }, true, when)).toMatch(/hasn't connected/);
    expect(addonStatus({ online: true, lastSeen: 1 }, false, when)).toMatch(/doesn't offer/);
  });

  it("picks the first free key", () => {
    const slots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(firstFreeSlot({ "0": "u1", "1": "u2" }, slots)).toBe(2);
    expect(firstFreeSlot(Object.fromEntries(slots.map((s) => [String(s), "x"])), slots)).toBe(0);
  });
});

describe("where an add-on is linked, and what removing it takes", () => {
  it("says whose account, which space and which server", () => {
    expect(
      linkedText({
        space: "Jesse's home",
        owner: { name: "Jesse", address: "jesse@hub.example" },
        server: "hub.example",
      }),
    ).toBe("Linked to Jesse (jesse@hub.example), in Jesse's home, on hub.example.");
    expect(linkedText({ space: "Home" })).toBe("Linked to you, in Home.");
  });

  it("names the shares and the people who lose them", () => {
    expect(removalText({ name: "seat", shares: [] })).toBe(
      "seat is cut off at once and its address stops working.",
    );
    expect(
      removalText({
        name: "seat",
        shares: [
          { label: "Book club", holders: [1, 2] },
          { label: "Garden", holders: [] },
        ],
      }),
    ).toBe(
      "seat is cut off at once and its address stops working; its 2 shares (Book club, Garden) go, and the 2 people you gave them to lose them.",
    );
    expect(removalText({ name: "seat", shares: [{ label: "Book club", holders: [1] }] })).toBe(
      "seat is cut off at once and its address stops working; its share (Book club) goes, and the person you gave it to loses it.",
    );
  });
});

describe("goneText", () => {
  it("tells the owner what went with a removed add-on", () => {
    expect(
      goneText({
        id: "g1",
        what: "removed",
        addon: "seat",
        at: 0,
        shares: [
          { label: "Book club", holders: ["Ana", "Bob"] },
          { label: "Garden", holders: ["Ana"] },
        ],
      }),
    ).toBe(
      "seat was removed and its address stopped working. Its shares Book club, Garden went; Ana, Bob no longer have them.",
    );
    expect(goneText({ id: "g2", what: "removed", addon: "seat", at: 0, shares: [] })).toBe(
      "seat was removed and its address stopped working.",
    );
  });
});

describe("addonTestText", () => {
  it("says how Test connection went in plain words", () => {
    expect(addonTestText({ state: "ok", ms: 42 })).toBe("Answered in 42 ms.");
    expect(
      addonTestText({ state: "ok", ms: 42, version: "seat/1.4", uptimeS: 3 * 3600, calls: 1 }),
    ).toBe("Answered in 42 ms · seat/1.4 · up 3 hours · on 1 call.");
    expect(addonTestText({ state: "offline" })).toBe("Not connected.");
    expect(addonTestText({ state: "timeout" })).toBe("Connected but didn't answer in 5 s.");
    expect(addonTestText({ state: "unavailable" })).toBe("You can't reach it now.");
  });
});

describe("stoppedText", () => {
  it("says why a share you hold stopped, or went, in plain words", () => {
    expect(stoppedText("not_connected", "Jesse")).toBe(
      "Stopped: you're no longer connected with Jesse.",
    );
    expect(stoppedText("suspended", "Jesse")).toBe("Stopped: Jesse's account is suspended.");
    expect(stoppedText("addons_off_there", "Jesse")).toBe(
      "Stopped: add-ons are off on that server.",
    );
    expect(stoppedText("removed", "Jesse")).toBe("Gone: Jesse removed the add-on.");
    expect(stoppedText("taken_back", "Jesse")).toBe("Gone: Jesse took it back.");
  });
});
