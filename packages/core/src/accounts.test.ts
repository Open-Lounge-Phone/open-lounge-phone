import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  deviceLabel,
  groupRecoveryCode,
  lastRecoveryGroup,
  normalizeRecoveryCode,
  RECOVERY_CODE_CHARS,
  recoveryCodeFrom,
  SESSION_REFRESH_MS,
  sessionShouldSlide,
} from "./accounts.ts";

describe("recovery codes", () => {
  it("are 28 base32 characters (140 bits) in groups of four", () => {
    const code = recoveryCodeFrom(new Uint8Array(18).fill(0xff));
    expect(code).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{4}$/);
    expect(code.replace(/-/g, "")).toHaveLength(RECOVERY_CODE_CHARS);
    expect(recoveryCodeFrom(new Uint8Array(18))).toBe("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    // Every bit counts: different bytes, different codes.
    const a = recoveryCodeFrom(Uint8Array.from({ length: 18 }, (_, i) => i));
    const b = recoveryCodeFrom(Uint8Array.from({ length: 18 }, (_, i) => (i === 17 ? 0 : i)));
    expect(a).not.toBe(b);
    expect(() => recoveryCodeFrom(new Uint8Array(17))).toThrow();
  });

  it("reads what people type: any case, spaces, dashes and look-alike digits", () => {
    const code = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23";
    expect(normalizeRecoveryCode(code)).toBe(code.replace(/-/g, ""));
    expect(normalizeRecoveryCode(" abcd efgh ijkl mnop qrst uvwx yz23 ")).toBe(
      code.replace(/-/g, ""),
    );
    expect(normalizeRecoveryCode("ABCD-EFGH-1JKL-MN0P-QRST-UVWX-YZ23")).toBe(
      code.replace(/-/g, ""),
    );
    expect(normalizeRecoveryCode("ABCD")).toBeUndefined();
    expect(normalizeRecoveryCode("ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ2!")).toBeUndefined();
    expect(groupRecoveryCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(lastRecoveryGroup(code)).toBe("YZ23");
  });

  it("compares in constant time and gets the answer right", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("sessions", () => {
  const base = { passkey: true, limited: false, lastUsedAt: 0, createdAt: 0 };
  it("slide at most once a day, and only when backed by a passkey", () => {
    expect(sessionShouldSlide(base, SESSION_REFRESH_MS - 1)).toBe(false);
    expect(sessionShouldSlide(base, SESSION_REFRESH_MS)).toBe(true);
    expect(sessionShouldSlide({ ...base, passkey: false }, SESSION_REFRESH_MS * 3)).toBe(false);
    expect(sessionShouldSlide({ ...base, limited: true }, SESSION_REFRESH_MS * 3)).toBe(false);
    expect(sessionShouldSlide({ ...base, lastUsedAt: null }, SESSION_REFRESH_MS)).toBe(true);
  });

  it("name the browser and system", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome on Mac");
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      deviceLabel("Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox on Windows");
    expect(deviceLabel(undefined)).toBe("A browser or app");
  });
});
