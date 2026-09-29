import { describe, expect, it } from "vitest";
import { deviceFingerprint, FINGERPRINT_WORDS, fingerprintWords } from "./fingerprint.ts";

describe("device fingerprint", () => {
  it("has a fixed list of 256 distinct short words", () => {
    expect(FINGERPRINT_WORDS).toHaveLength(256);
    expect(new Set(FINGERPRINT_WORDS).size).toBe(256);
    for (const w of FINGERPRINT_WORDS) expect(w).toMatch(/^[a-z]{3,7}$/);
    expect([...FINGERPRINT_WORDS].sort()).toEqual(FINGERPRINT_WORDS);
    // Pinned: the list is part of the protocol (firmware carries it); never reorder or edit.
    expect([FINGERPRINT_WORDS[0], FINGERPRINT_WORDS[128], FINGERPRINT_WORDS[255]]).toEqual([
      "acorn",
      "island",
      "zebra",
    ]);
    expect(FINGERPRINT_WORDS.join(" ")).toHaveLength(1663);
  });

  it("maps the first four digest bytes to words", () => {
    expect(fingerprintWords(new Uint8Array([0, 1, 254, 255, 9]))).toEqual([
      "acorn",
      "anchor",
      FINGERPRINT_WORDS[254],
      "zebra",
    ]);
    expect(() => fingerprintWords(new Uint8Array(3))).toThrow();
  });

  it("is the SHA-256 of the raw key, the same for the phone and the app", async () => {
    // 32 zero bytes: SHA-256 = 66 68 7a ad f8 62 …
    const zeros = "A".repeat(43);
    expect(await deviceFingerprint(zeros)).toEqual([
      FINGERPRINT_WORDS[0x66],
      FINGERPRINT_WORDS[0x68],
      FINGERPRINT_WORDS[0x7a],
      FINGERPRINT_WORDS[0xad],
    ]);
    expect(await deviceFingerprint(`B${"A".repeat(42)}`)).not.toEqual(
      await deviceFingerprint(zeros),
    );
  });
});
