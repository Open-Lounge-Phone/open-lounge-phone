import { describe, expect, it } from "vitest";
import { formatCount, fundingSummary, HUB_FUNDING, peopleFor } from "./funding.ts";

describe("hub funding", () => {
  it("computes the published numbers from the configuration", () => {
    expect(fundingSummary(HUB_FUNDING)).toEqual({
      balanceUsd: 150,
      peoplePerDollarPerMonth: 50,
      peopleForAYear: 375,
      peopleForSixMonths: 1000,
    });
    expect(formatCount(1000)).toBe("1,000");
  });

  it("follows the configuration", () => {
    const more = { ...HUB_FUNDING, balanceUsd: 600 };
    expect(fundingSummary(more).peopleForAYear).toBe(2250); // (600/12 - 5) / 0.02
    expect(peopleFor({ ...HUB_FUNDING, costPerActiveUserUsdPerMonth: 0.04 }, 12)).toBe(187);
  });

  it("never goes negative, and survives a zero cost", () => {
    expect(peopleFor({ ...HUB_FUNDING, balanceUsd: 10 }, 12)).toBe(0);
    expect(peopleFor(HUB_FUNDING, 0)).toBe(0);
    expect(fundingSummary({ ...HUB_FUNDING, costPerActiveUserUsdPerMonth: 0 })).toMatchObject({
      peoplePerDollarPerMonth: 0,
      peopleForAYear: 0,
    });
  });
});
