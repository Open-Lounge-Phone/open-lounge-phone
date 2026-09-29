// Regenerates the schema blocks of docs/federation-spec.md: `npm run docs:federation`.
import { readFileSync, writeFileSync } from "node:fs";
import { fillSpec } from "../src/spec.ts";

const target = new URL("../../../docs/federation-spec.md", import.meta.url);
writeFileSync(target, fillSpec(readFileSync(target, "utf8")));
console.log(`wrote ${target.pathname}`);
