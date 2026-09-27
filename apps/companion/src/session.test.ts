import { describe, expect, it } from "vitest";
import { loadToken, readSetupToken, saveToken, TOKEN_KEY } from "./session.ts";

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("session", () => {
  it("saves, loads and clears the token", () => {
    const s = memoryStorage();
    expect(loadToken(s)).toBeNull();
    saveToken(s, "a".repeat(43));
    expect(loadToken(s)).toBe("a".repeat(43));
    saveToken(s, null);
    expect(s.m.has(TOKEN_KEY)).toBe(false);
  });

  it("ignores implausibly short stored tokens", () => {
    const s = memoryStorage();
    s.setItem(TOKEN_KEY, "short");
    expect(loadToken(s)).toBeNull();
  });

  it("reads the setup token from the hash", () => {
    expect(readSetupToken("#setup=RjD7EYZ_-9")).toBe("RjD7EYZ_-9");
    expect(readSetupToken("setup=abc&x=1")).toBe("abc");
    expect(readSetupToken("#other=1")).toBeUndefined();
    expect(readSetupToken("")).toBeUndefined();
    expect(readSetupToken("#setup=")).toBeUndefined();
  });
});
