import { describe, expect, it } from "vitest";
import { normalizeUrl, parseCli } from "./args.ts";

describe("parseCli", () => {
  it("help and version", () => {
    expect(parseCli([])).toEqual({ kind: "help" });
    expect(parseCli(["help", "deploy"])).toEqual({ kind: "help", topic: "deploy" });
    expect(parseCli(["status", "--help"])).toEqual({ kind: "help", topic: "status" });
    expect(parseCli(["--version"])).toEqual({ kind: "version" });
  });

  it("deploy cloudflare with options", () => {
    const cmd = parseCli([
      "deploy",
      "cloudflare",
      "--instance",
      "hub",
      "--domain",
      "Hub.Example.org",
      "--open-signup",
      "--no-ai",
      "--fair-use",
      "none",
      "--operator",
      "jesse",
      "-y",
    ]);
    expect(cmd).toEqual({
      kind: "deploy",
      target: "cloudflare",
      opts: {
        instance: "hub",
        domain: "hub.example.org",
        openSignup: true,
        ai: false,
        fairUse: "none",
        operator: "jesse",
        refuseRecordedCalls: false,
        newSetupToken: false,
        yes: true,
        dryRun: false,
      },
    });
    expect(parseCli(["deploy", "cloudflare", "--invite-only"])).toMatchObject({
      opts: { openSignup: false, ai: true },
    });
  });

  it("refuses secrets as flags, in either spelling", () => {
    for (const flag of [
      "--turn-key-token",
      "--turn-key-token=abc",
      "--sfu-app-secret",
      "--turnstile-secret=x",
    ]) {
      const cmd = parseCli(["deploy", "cloudflare", flag, "v"]);
      expect(cmd.kind, flag).toBe("error");
      expect((cmd as { message: string }).message).toMatch(/environment/);
    }
  });

  it("rejects unknown commands, targets, flags and contradictions", () => {
    expect(parseCli(["deploy", "aws"]).kind).toBe("error");
    expect(parseCli(["deploy", "cloudflare", "--bogus"]).kind).toBe("error");
    expect(parseCli(["deploy", "cloudflare", "--open-signup", "--invite-only"]).kind).toBe("error");
    expect(parseCli(["deploy", "cloudflare", "--fair-use", "some"]).kind).toBe("error");
    expect(parseCli(["selfhost", "up"]).kind).toBe("error");
    expect(parseCli(["selfhost", "init", "--coturn", "--no-coturn"]).kind).toBe("error");
    expect(parseCli(["frobnicate"]).kind).toBe("error");
    expect(parseCli(["status"]).kind).toBe("error");
    expect(parseCli(["doctor", "extra"]).kind).toBe("error");
  });

  it("selfhost init", () => {
    expect(parseCli(["selfhost", "init"])).toEqual({
      kind: "selfhost-init",
      opts: { dir: ".", force: false, yes: false },
    });
    expect(
      parseCli([
        "selfhost",
        "init",
        "--dir",
        "srv",
        "--public-url",
        "phone.example.com/path",
        "--coturn",
        "--no-livekit",
        "--open-signup",
        "--force",
      ]),
    ).toEqual({
      kind: "selfhost-init",
      opts: {
        dir: "srv",
        publicUrl: "https://phone.example.com",
        coturn: true,
        livekit: false,
        openSignup: true,
        force: true,
        yes: false,
      },
    });
  });

  it("status normalizes the URL", () => {
    expect(parseCli(["status", "l1.openloungephone.app"])).toEqual({
      kind: "status",
      url: "https://l1.openloungephone.app",
      json: false,
    });
    expect(parseCli(["status", "http://localhost:8787/", "--json"])).toEqual({
      kind: "status",
      url: "http://localhost:8787",
      json: true,
    });
  });
});

describe("normalizeUrl", () => {
  it("accepts http(s) origins only", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("https://a.example.com:8443/x?y")).toBe("https://a.example.com:8443");
    expect(normalizeUrl("ftp://example.com")).toBeUndefined();
    expect(normalizeUrl("https://user:pw@example.com")).toBeUndefined();
    expect(normalizeUrl("not a url")).toBeUndefined();
  });
});
