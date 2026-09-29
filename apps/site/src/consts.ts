import { type FundingConfig, HUB_FUNDING } from "@openloungephone/core";

/** Public repository URL; empty until published (see scripts/sync-docs.ts). */
export const GITHUB_URL = "";

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const num = (name: string, fallback: number): number => {
  const v = Number(env(name));
  return env(name) !== undefined && Number.isFinite(v) ? v : fallback;
};

/**
 * GitHub Sponsors link, set at build time (`SPONSOR_URL`). The same setting as the hub's. While
 * it's unset, no Sponsor button is shown anywhere — never a placeholder.
 */
export const SPONSOR_URL = /^https:\/\/\S+$/.test(env("SPONSOR_URL") ?? "")
  ? (env("SPONSOR_URL") as string)
  : undefined;

/** The hub's funding, as configured for the build (defaults: the hub's current numbers). */
export const FUNDING: FundingConfig = {
  balanceUsd: num("FUNDING_BALANCE_USD", HUB_FUNDING.balanceUsd),
  baseCostUsdPerMonth: num("BASE_COST_USD_PER_MONTH", HUB_FUNDING.baseCostUsdPerMonth),
  costPerActiveUserUsdPerMonth: num(
    "COST_PER_ACTIVE_USER_USD_PER_MONTH",
    HUB_FUNDING.costPerActiveUserUsdPerMonth,
  ),
};

export const CREDIT = {
  text: "Proudly supported by unsubscribe.llc",
  url: "https://www.unsubscribe.llc/",
};
