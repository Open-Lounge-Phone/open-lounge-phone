import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "./base64url.ts";

describe("base64url", () => {
  it("round-trips every length modulo 3", () => {
    for (const len of [0, 1, 2, 3, 32, 64]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 250) % 256);
      const enc = toBase64Url(bytes);
      expect(enc).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(fromBase64Url(enc)).toEqual(bytes);
    }
  });
  it("has the lengths the protocol expects for Ed25519", () => {
    expect(toBase64Url(new Uint8Array(32))).toHaveLength(43);
    expect(toBase64Url(new Uint8Array(64))).toHaveLength(86);
  });
  it("uses the URL-safe alphabet", () => {
    expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });
  it("rejects standard base64 characters", () => {
    expect(() => fromBase64Url("+/8")).toThrow();
  });
});
