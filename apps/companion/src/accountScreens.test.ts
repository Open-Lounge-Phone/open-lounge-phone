import { describe, expect, it } from "vitest";
import { recoveryFileText } from "./RecoveryCode.tsx";
import { showDevSignIn } from "./Start.tsx";

describe("sign-in screens", () => {
  it("hide the developer sign-in unless this is a dev build or the URL asks", () => {
    expect(showDevSignIn(false, "")).toBe(false);
    expect(showDevSignIn(false, "?x=1")).toBe(false);
    expect(showDevSignIn(false, "?dev")).toBe(true);
    expect(showDevSignIn(true, "")).toBe(true);
  });

  it("the saved recovery file says what the code is, for which account, and to keep it private", () => {
    const text = recoveryFileText("ABCD-EFGH", "jo@phone.example", "phone.example");
    expect(text).toContain("ABCD-EFGH");
    expect(text).toContain("jo@phone.example");
    expect(text).toContain("https://phone.example");
    expect(text).toMatch(/anyone with your handle and this code can get into your account/);
  });
});
