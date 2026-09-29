import { describe, expect, it } from "vitest";
import { guestLoungeUrl, loungeReasonText, parseLoungeLink } from "./loungeLink.ts";

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

describe("guests from other servers", () => {
  const nonce = "AbCdEfGhIjKlMnOpQrStUv";
  it("parses the phone's server after @", () => {
    expect(parseLoungeLink("/lounge", `#dev_abc.${nonce}@lounge.example:8443`)).toEqual({
      deviceId: "dev_abc",
      nonce,
      host: "lounge.example:8443",
    });
    expect(parseLoungeLink("/lounge", `#dev_abc.${nonce}@bad host`)).toBeUndefined();
  });

  it("sends a guest on to their own server, from an address, host or URL", () => {
    const link = { deviceId: "dev_abc", nonce };
    const want = `https://hub.example/lounge#dev_abc.${nonce}@bar.example`;
    expect(guestLoungeUrl("jesse@hub.example", link, "bar.example")).toBe(want);
    expect(guestLoungeUrl("https://hub.example/", link, "bar.example")).toBe(want);
    expect(guestLoungeUrl(" HUB.example ", link, "bar.example")).toBe(want);
    expect(guestLoungeUrl("a.localhost:8787", link, "b.localhost:8788")).toBe(
      `http://a.localhost:8787/lounge#dev_abc.${nonce}@b.localhost:8788`,
    );
    expect(guestLoungeUrl("bar.example", link, "bar.example")).toBeUndefined();
    expect(guestLoungeUrl("not a server", link, "bar.example")).toBeUndefined();
  });
});
