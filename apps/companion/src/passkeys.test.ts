import { describe, expect, it } from "vitest";
import { ApiError } from "./api.ts";
import {
  AddressMismatch,
  addressMatches,
  defaultPasskeyName,
  passkeyErrorText,
} from "./passkeys.ts";

describe("passkeys", () => {
  it("explains common failures", () => {
    // Cancelled (or this device can't make one): point at the other ways.
    expect(passkeyErrorText({ name: "NotAllowedError" })).toMatch(
      /No passkey was used.*phone, a security key/,
    );
    expect(passkeyErrorText({ code: "ERROR_CEREMONY_ABORTED" })).toMatch(/No passkey was used/);
    expect(passkeyErrorText({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toMatch(
      /already has a passkey/,
    );
    expect(passkeyErrorText({ name: "SecurityError" })).toMatch(/can't use passkeys here.*https/);
    expect(passkeyErrorText(new Error("server said no"))).toBe("Passkey failed: server said no");
    expect(passkeyErrorText(undefined)).toBe("Passkey failed.");
    // The server's own words (e.g. a passkey it no longer knows) as they are.
    expect(
      passkeyErrorText(new ApiError(401, "This passkey isn't linked to an account here any more.")),
    ).toBe("This passkey isn't linked to an account here any more.");
    expect(passkeyErrorText(new AddressMismatch("phone.example.org"))).toMatch(
      /address doesn't match.*https:\/\/phone\.example\.org/,
    );
  });

  it("knows when this page's address can't use the server's passkeys", () => {
    expect(addressMatches("phone.example.org", "phone.example.org")).toBe(true);
    expect(addressMatches("example.org", "phone.example.org")).toBe(true);
    expect(addressMatches("phone.example.org", "localhost")).toBe(false);
    expect(addressMatches("phone.example.org", "evilphone.example.org")).toBe(false);
    expect(addressMatches(undefined, "anywhere")).toBe(true);
  });

  it("names passkeys after the device", () => {
    expect(defaultPasskeyName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(
      "iPhone",
    );
    expect(defaultPasskeyName("Mozilla/5.0 (Linux; Android 15)")).toBe("Android phone");
    expect(defaultPasskeyName("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("Mac");
    expect(defaultPasskeyName("curl")).toBe("Passkey");
  });
});
