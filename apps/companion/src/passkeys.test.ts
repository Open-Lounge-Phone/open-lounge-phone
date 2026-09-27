import { describe, expect, it } from "vitest";
import { defaultPasskeyName, passkeyErrorText } from "./passkeys.ts";

describe("passkeys", () => {
  it("explains common failures", () => {
    expect(passkeyErrorText({ name: "NotAllowedError" })).toMatch(/Cancelled/);
    expect(passkeyErrorText({ code: "ERROR_CEREMONY_ABORTED" })).toMatch(/Cancelled/);
    expect(passkeyErrorText({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" })).toMatch(
      /already has a passkey/,
    );
    expect(passkeyErrorText({ name: "SecurityError" })).toMatch(/HTTPS/);
    expect(passkeyErrorText(new Error("server said no"))).toBe("Passkey failed: server said no");
    expect(passkeyErrorText(undefined)).toBe("Passkey failed.");
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
