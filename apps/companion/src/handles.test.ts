import { describe, expect, it } from "vitest";
import { handleHint, inviteTokenFrom, normalizeHandle, suggestHandle } from "./handles.ts";

describe("handles", () => {
  it("suggests a handle from a name", () => {
    expect(suggestHandle("José Díaz")).toBe("jose.diaz");
    expect(suggestHandle("  Grandma Jo ")).toBe("grandma.jo");
    expect(suggestHandle("O'Brien")).toBe("obrien");
    expect(suggestHandle("🙂")).toBe("");
  });

  it("explains bad handles", () => {
    expect(handleHint("jesse")).toBeUndefined();
    expect(handleHint("j")).toMatch(/2/);
    expect(handleHint("x".repeat(31))).toMatch(/30/);
    expect(handleHint("jes se")).toMatch(/lower-case/);
    expect(handleHint(normalizeHandle(" Jesse "))).toBeUndefined();
  });

  it("reads invite tokens from links or bare tokens", () => {
    const token = "a".repeat(43);
    expect(inviteTokenFrom(`https://l1.example/#invite=${token}`)).toBe(token);
    expect(inviteTokenFrom(`  ${token} `)).toBe(token);
    expect(inviteTokenFrom("https://l1.example/")).toBeUndefined();
    expect(inviteTokenFrom("hello")).toBeUndefined();
  });
});
