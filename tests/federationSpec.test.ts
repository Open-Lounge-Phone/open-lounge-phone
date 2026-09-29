import { readFileSync } from "node:fs";
import { FED_ENDPOINTS } from "@openloungephone/federation";
import { fillSpec, renderEndpoints } from "@openloungephone/federation/spec";
import { describe, expect, it } from "vitest";

const doc = readFileSync(new URL("../docs/federation-spec.md", import.meta.url), "utf8");

describe("docs/federation-spec.md", () => {
  it("matches the schemas (run `npm run docs:federation` after changing them)", () => {
    expect(fillSpec(doc) === doc, "docs/federation-spec.md is out of date").toBe(true);
  });

  it("documents every endpoint once", () => {
    const text = renderEndpoints();
    for (const e of FED_ENDPOINTS) {
      expect(text.split(`### \`${e.method} ${e.path}\``).length - 1).toBe(1);
    }
  });
});
