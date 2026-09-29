import { readFileSync } from "node:fs";
import {
  FED_ENDPOINTS,
  keyRotationStatement,
  MAX_ROTATION_OVERLAP_S,
  ROTATION_OVERLAP_S,
} from "@openloungephone/federation";
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

  it("gives the key rotation statement and windows exactly as the code signs and checks them", () => {
    const statement = keyRotationStatement({
      host: "<host>",
      previousKey: "<previous_key>",
      newKey: "<server_key>",
      created: "<created>" as unknown as number,
      expires: "<expires>" as unknown as number,
    });
    expect(doc).toContain(`\`\`\`\n${statement}\n\`\`\``);
    expect(ROTATION_OVERLAP_S).toBe(7 * 86_400);
    expect(doc).toContain("SHOULD use **7 days**");
    expect(doc).toContain(`\`expires − created ≤ ${MAX_ROTATION_OVERLAP_S}\``);
  });
});
