import { describe, expect, it } from "vitest";
import {
  addressProblem,
  extensionDigits,
  extensionProblem,
  requiredProblem,
  sentence,
  serverName,
  serverProblem,
  timeProblem,
  wholeNumber,
} from "./fields.ts";

describe("form field checks", () => {
  it("makes sentences", () => {
    expect(sentence("write a notice")).toBe("Write a notice.");
    expect(sentence("Done!")).toBe("Done!");
    expect(sentence("  ")).toBe("");
  });

  it("requires text that isn't only spaces", () => {
    expect(requiredProblem("   ", "a name")).toBe("Enter a name.");
    expect(requiredProblem(" Ann ", "a name")).toBeUndefined();
  });

  it("checks extensions like the server (2 to 6 digits)", () => {
    expect(extensionProblem("")).toMatch(/2 to 6 digits/);
    expect(extensionProblem("1")).toBe("Use 2 to 6 digits.");
    expect(extensionProblem("12")).toBeUndefined();
    expect(extensionProblem("123456")).toBeUndefined();
    expect(extensionProblem("1234567")).toBe("Use 2 to 6 digits.");
    expect(extensionDigits("ext 2-01x9999")).toBe("201999");
  });

  it("checks addresses: name@server", () => {
    expect(addressProblem("")).toMatch(/name@server/);
    expect(addressProblem(" Ann@Example.org ")).toBeUndefined();
    expect(addressProblem("example.org")).toMatch(/That's a server/);
    expect(addressProblem("ann@")).toMatch(/doesn't look like an address/);
    expect(addressProblem("a@example.org")).toMatch(/doesn't look like an address/);
    expect(addressProblem("ann smith@example.org")).toMatch(/doesn't look like an address/);
  });

  it("reads a server's name from what people paste", () => {
    expect(serverName(" https://Spam.Example/some/path?x ")).toBe("spam.example");
    expect(serverName("@spam.example")).toBe("spam.example");
    expect(serverName("ann@spam.example")).toBe("spam.example");
    expect(serverName("spam.example.")).toBe("spam.example");
    expect(serverProblem("https://spam.example/")).toBeUndefined();
    expect(serverProblem("spam.example:8443")).toBeUndefined();
    expect(serverProblem("")).toMatch(/Enter the server's name/);
    expect(serverProblem("not a server")).toMatch(/doesn't look like a server's name/);
  });

  it("reads whole numbers in a range", () => {
    expect(wholeNumber("10", 1, 240)).toEqual({ value: 10 });
    expect(wholeNumber(" 240 ", 1, 240)).toEqual({ value: 240 });
    for (const bad of ["", "0", "241", "2.5", "x"]) {
      expect(wholeNumber(bad, 1, 240)).toEqual({ problem: "Use a whole number from 1 to 240." });
    }
  });

  it("asks for a time when the field is cleared", () => {
    expect(timeProblem("09:30")).toBeUndefined();
    expect(timeProblem("")).toBe("Pick a time.");
    expect(timeProblem("", "the start time")).toBe("Pick the start time.");
    expect(timeProblem("24:00")).toBe("Pick a time.");
  });
});
