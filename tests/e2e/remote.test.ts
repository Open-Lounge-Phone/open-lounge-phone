// Runs the end-to-end scenario against an already running server, e.g. `wrangler dev`:
//   OTC_E2E_URL=http://localhost:8788 OTC_E2E_SETUP_TOKEN=... npx vitest run tests/e2e
// The target must be fresh (no household yet).
import { it } from "vitest";
import { pairAndCall } from "./scenario.ts";

const base = process.env.OTC_E2E_URL;
const setupToken = process.env.OTC_E2E_SETUP_TOKEN;

it.skipIf(!base || !setupToken)(
  "pairs and calls against $OTC_E2E_URL",
  async () => {
    await pairAndCall({ base: base as string, setupToken: setupToken as string });
  },
  60_000,
);
