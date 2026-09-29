#!/usr/bin/env node
// `npx openloungephone …` (in this repository) or `node apps/cli/bin/openloungephone.js …`.
// Runs the TypeScript sources directly (Node ≥ 22.18 strips types; no build step).
import { main } from "../src/main.ts";

process.exitCode = await main(process.argv.slice(2));
