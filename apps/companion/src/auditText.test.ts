import { describe, expect, it } from "vitest";
import { auditText } from "./auditText.ts";

describe("audit trail words", () => {
  it("team and org changes", () => {
    expect(auditText("extension.set", { number: "201" })).toBe("set extension 201");
    expect(auditText("role.change", { name: "Ben", role: "admin" })).toBe("made Ben an admin");
    expect(auditText("recording.update", { enabled: true })).toBe("turned call recording on");
    expect(auditText("line.enable", { address: "help@acme.example" })).toBe(
      "made help@acme.example public (confirmed the warning)",
    );
    expect(auditText("line.block", { value: "far.example" })).toBe(
      "blocked far.example from the public lines",
    );
  });

  it("home changes: phones, quiet hours, notices, the space itself", () => {
    expect(auditText("quiet.update", { rules: 2 })).toBe("changed quiet hours");
    expect(auditText("phone.key", { phone: "Ana's phone", index: 9 })).toBe(
      "changed key 0 on Ana's phone",
    );
    expect(auditText("phone.key", { phone: "Ana's phone", index: 0 })).toBe(
      "changed key 1 on Ana's phone",
    );
    expect(auditText("phone.contact", { phone: "Ana's phone", name: "Gran" })).toBe(
      "changed what Ana's phone may do with Gran",
    );
    expect(auditText("phone.greeting", { phone: "Ana's phone", kind: "default" })).toBe(
      "reset Ana's phone's greeting",
    );
    expect(auditText("notice.post", { noticeId: "n1", minutes: 60 })).toBe("posted a notice");
    expect(auditText("space.rename", { from: "Mom's home", to: "The Smiths" })).toBe(
      'renamed "Mom\'s home" to "The Smiths"',
    );
    expect(auditText("space.timezone", { from: "UTC", to: "America/New_York" })).toBe(
      "changed the time zone to New York (was UTC)",
    );
  });

  it("add-ons: linking, who may talk to them, removing, a key on a phone", () => {
    expect(auditText("addon.link", { name: "seat", allowed: 0 })).toBe("linked add-on seat");
    expect(auditText("addon.link", { name: "seat", allowed: 2 })).toBe(
      "linked add-on seat (2 connections may talk to it)",
    );
    expect(auditText("addon.allow", { name: "seat", allowed: 1 })).toBe(
      "let 1 connection talk to add-on seat",
    );
    expect(auditText("addon.allow", { name: "seat", allowed: 0 })).toBe(
      "made add-on seat theirs alone",
    );
    expect(auditText("addon.remove", { name: "seat" })).toBe("removed add-on seat");
    expect(auditText("addon.grant", { name: "seat", label: "Book club", to: "ana@a.test" })).toBe(
      "gave Book club of add-on seat to ana@a.test",
    );
    expect(auditText("addon.revoke", { name: "seat", share: "bookclub", from: "ana@a.test" })).toBe(
      "took bookclub of add-on seat back from ana@a.test",
    );
    expect(auditText("addon.share.request", { name: "seat", label: "Garden" })).toBe(
      "asked add-on seat for a new share, Garden",
    );
    expect(auditText("addon.share.timeout", { name: "seat", label: "Garden" })).toBe(
      "add-on seat didn't answer about Garden",
    );
    expect(auditText("phone.line", { phone: "Desk", address: "jo+seat@x.example" })).toBe(
      "put add-on jo+seat@x.example on Desk",
    );
  });

  it("anything newer than this app: its name", () => {
    expect(auditText("something.new", null)).toBe("something.new");
  });
});
