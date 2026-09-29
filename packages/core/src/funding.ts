/**
 * How far the public hub's donations go. Pure: every number shown on the site and in the app is
 * computed here from the configuration, never written by hand.
 */
export interface FundingConfig {
  /** Money available, in US dollars. */
  balanceUsd: number;
  /** Fixed monthly cost (Cloudflare Workers Paid). */
  baseCostUsdPerMonth: number;
  /** Cost of one active person per month (calls mostly peer-to-peer; some relayed). */
  costPerActiveUserUsdPerMonth: number;
}

export const HUB_FUNDING: FundingConfig = {
  balanceUsd: 150,
  baseCostUsdPerMonth: 5,
  costPerActiveUserUsdPerMonth: 0.02,
};

export interface FundingSummary {
  balanceUsd: number;
  /** People each $1/month of donations keeps on the hub. */
  peoplePerDollarPerMonth: number;
  /** People the balance serves for a year, and for six months. */
  peopleForAYear: number;
  peopleForSixMonths: number;
}

/** People the balance keeps running for `months` (after the fixed cost); never negative. */
export function peopleFor(config: FundingConfig, months: number): number {
  if (months <= 0 || config.costPerActiveUserUsdPerMonth <= 0) return 0;
  const perMonth = config.balanceUsd / months - config.baseCostUsdPerMonth;
  // Rounded to 2 decimals first so 374.99999 (float noise) counts as 375.
  const people = Math.round((perMonth / config.costPerActiveUserUsdPerMonth) * 100) / 100;
  return Math.max(0, Math.floor(people));
}

export function fundingSummary(config: FundingConfig): FundingSummary {
  const perDollar =
    config.costPerActiveUserUsdPerMonth > 0
      ? Math.floor(Math.round((1 / config.costPerActiveUserUsdPerMonth) * 100) / 100)
      : 0;
  return {
    balanceUsd: config.balanceUsd,
    peoplePerDollarPerMonth: perDollar,
    peopleForAYear: peopleFor(config, 12),
    peopleForSixMonths: peopleFor(config, 6),
  };
}

/** "375", "1,000", "12,500": people counts for display. */
export const formatCount = (n: number): string => n.toLocaleString("en-US");
