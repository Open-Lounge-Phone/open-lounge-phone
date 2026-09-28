import { describe, expect, it } from "vitest";
import { loungeReasonText, parseLoungeLink } from "./loungeLink.ts";

describe("parseLoungeLink", () => {
  const nonce = "AbCdEfGhIjKlMnOpQrStUv";
  it("reads the device and nonce from the QR link", () => {
    expect(parseLoungeLink("/lounge", `#dev_abc.${nonce}`)).toEqual({
      deviceId: "dev_abc",
      nonce,
    });
    expect(parseLoungeLink("/lounge/", `#dev_abc.${nonce}`)?.deviceId).toBe("dev_abc");
  });

  it("ignores other pages and malformed links", () => {
    expect(parseLoungeLink("/", `#dev_abc.${nonce}`)).toBeUndefined();
    expect(parseLoungeLink("/lounge", "")).toBeUndefined();
    expect(parseLoungeLink("/lounge", `#.${nonce}`)).toBeUndefined();
    expect(parseLoungeLink("/lounge", "#dev_abc.short")).toBeUndefined();
    expect(parseLoungeLink("/lounge", `#dev abc.${nonce}`)).toBeUndefined();
  });

  it("explains failures", () => {
    expect(loungeReasonText("wrong_key")).toMatch(/flashing key/);
    expect(loungeReasonText("idle")).toMatch(/unused/);
    expect(loungeReasonText(undefined)).toMatch(/went wrong/);
  });
});
