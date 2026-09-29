import { describe, expect, it } from "vitest";
import { nodeCheck, runChecks } from "./doctor.ts";

describe("doctor", () => {
  it("needs Node 22.18 or newer", () => {
    expect(nodeCheck("v22.18.0").ok).toBe(true);
    expect(nodeCheck("v24.1.0").ok).toBe(true);
    expect(nodeCheck("v22.6.0").ok).toBe(false);
    expect(nodeCheck("v20.19.0").ok).toBe(false);
  });

  it("reports missing tools as warnings, not failures", () => {
    const checks = runChecks("/nonexistent", () => ({ code: 127, out: "not found" }));
    const docker = checks.find((c) => c.name === "Docker");
    expect(docker).toMatchObject({ ok: false, required: false });
    expect(checks.find((c) => c.name === "npm install")).toMatchObject({
      ok: false,
      required: true,
    });
  });
});
