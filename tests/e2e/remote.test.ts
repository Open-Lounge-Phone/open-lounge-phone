// Runs the end-to-end scenario against an already running server, e.g. `wrangler dev`:
//   OLP_E2E_URL=http://localhost:8788 OLP_E2E_SETUP_TOKEN=... npx vitest run tests/e2e
// The target must be fresh (no household yet).
import { it } from "vitest";
import { pairAndCall } from "./scenario.ts";

const base = process.env.OLP_E2E_URL;
const setupToken = process.env.OLP_E2E_SETUP_TOKEN;

it.skipIf(!base || !setupToken)(
  "pairs and calls against $OLP_E2E_URL",
  async () => {
    await pairAndCall({ base: base as string, setupToken: setupToken as string });
  },
  60_000,
);
