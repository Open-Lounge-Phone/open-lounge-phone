// The phone firmware shows the same words for the server's refusal notes as the browser phone:
// firmware/main/phone.c WHY_NOTES mirrors packages/core/src/refusals.ts.
import { readFileSync } from "node:fs";
import { REFUSAL_NOTES, refusalStatus } from "@openloungephone/core";
import { expect, it } from "vitest";

it("the firmware's refusal notes and words match core's", () => {
  const src = readFileSync(new URL("../firmware/main/phone.c", import.meta.url), "utf8");
  const start = src.indexOf("WHY_NOTES[][2] = {");
  const table = src.slice(start, src.indexOf("};", start));
  const rows = [...table.matchAll(/\{"((?:[^"\\]|\\.)*)", "([^"]*)"\}/g)].map((m) => [m[1], m[2]]);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows).toEqual(REFUSAL_NOTES.map((n) => [n, refusalStatus(n)?.[0]]));
});
