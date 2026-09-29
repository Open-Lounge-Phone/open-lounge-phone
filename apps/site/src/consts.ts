import { type FundingConfig, HUB_FUNDING } from "@openloungephone/core";

/** Public repository URL; empty until published (see scripts/sync-docs.ts). */
export const GITHUB_URL = "";

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const num = (name: string, fallback: number): number => {
  const v = Number(env(name));
  return env(name) !== undefined && Number.isFinite(v) ? v : fallback;
};

/**
 * GitHub Sponsors link for the project (owner, 2026-09-29). A fork can override it with
 * `SPONSOR_URL` at build time, or hide the button with `SPONSOR_URL=none`.
 */
const PROJECT_SPONSOR_URL = "https://github.com/sponsors/previousdolphin";
const sponsorSetting = env("SPONSOR_URL") ?? PROJECT_SPONSOR_URL;
export const SPONSOR_URL = /^https:\/\/\S+$/.test(sponsorSetting) ? sponsorSetting : undefined;

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
