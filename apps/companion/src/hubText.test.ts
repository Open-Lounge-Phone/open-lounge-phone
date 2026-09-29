import { expect, it } from "vitest";
import type { HubInfo, UsageInfo } from "./api.ts";
import { fairUseLines, fundingLines } from "./hubText.ts";

const usage: UsageInfo = {
  month: "2026-09",
  callMinutes: 300,
  voicemails: 2,
  voicemailBytes: 0,
  knocks: 1,
  resetsAt: 0,
  resetsOn: "Oct 1",
  limits: { callMinutesPerMonth: 1000, voicemailsPerMonth: 100 },
  exempt: false,
};

it("describes the fair-use allowance, and nothing when unlimited or exempt", () => {
  expect(fairUseLines(usage)).toEqual(["300 of 1,000 call minutes", "2 of 100 voicemails"]);
  expect(fairUseLines({ ...usage, limits: null })).toEqual([]);
  expect(fairUseLines({ ...usage, exempt: true })).toEqual([]);
});

it("shows the funding numbers the server computed", () => {
  const hub: HubInfo = {
    fairUse: null,
    sponsorUrl: null,
    funding: {
      balanceUsd: 150,
      summary: {
        balanceUsd: 150,
        peoplePerDollarPerMonth: 50,
        peopleForAYear: 375,
        peopleForSixMonths: 1000,
      },
    },
  };
  expect(fundingLines(hub)).toEqual([
    "$150 in funding",
    "Every $1/month covers about 50 people",
    "$150 keeps the hub running for ~375 people for a year (or ~1,000 people for 6 months)",
  ]);
  expect(fundingLines({ ...hub, funding: null })).toEqual([]);
});
