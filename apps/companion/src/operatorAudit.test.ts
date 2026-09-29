import { describe, expect, it } from "vitest";
import { describeAudit } from "./operatorAudit.ts";

const entry = (action: string, detail: Record<string, unknown>, actor = true) => ({
  id: "oa_1",
  at: 0,
  actorAccount: actor ? "acc_1" : null,
  actorName: "Ada (@root)",
  action,
  detail,
});
const A = `SHA256:${"a".repeat(43)}`;
const B = `SHA256:${"b".repeat(43)}`;

describe("operator audit lines", () => {
  it("names who did what, with short fingerprints", () => {
    expect(describeAudit(entry("fedkey.rotate", { from: A, to: B }))).toBe(
      "Ada (@root) rotated this server's key (aaaaaaaaaaaa… → bbbbbbbbbbbb…)",
    );
    expect(
      describeAudit(entry("fedkey.rotated", { host: "b.example", from: A, to: B }, false)),
    ).toBe(
      "b.example rotated its key; followed its signed hand-over (aaaaaaaaaaaa… → bbbbbbbbbbbb…)",
    );
    expect(describeAudit(entry("fedkey.retrust", { host: "b.example", from: A, to: B }))).toMatch(
      /^Ada \(@root\) re-trusted b\.example/,
    );
    expect(describeAudit(entry("server.block", { host: "spam.example", reason: "spam" }))).toBe(
      "Ada (@root) blocked spam.example (spam)",
    );
    expect(describeAudit(entry("something.new", {}, false))).toBe("Automatically: something.new");
  });
});
