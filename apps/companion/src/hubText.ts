import type { HubInfo, UsageInfo } from "./api.ts";

/** "300 of 1,000 call minutes" lines for the fair-use card; empty when unlimited. Pure. */
export function fairUseLines(u: UsageInfo): string[] {
  if (!u.limits || u.exempt) return [];
  const n = (x: number) => x.toLocaleString("en-US");
  const lines: string[] = [];
  const l = u.limits;
  if (l.callMinutesPerMonth !== undefined) {
    lines.push(`${n(u.callMinutes)} of ${n(l.callMinutesPerMonth)} call minutes`);
  }
  if (l.voicemailsPerMonth !== undefined) {
    lines.push(`${n(u.voicemails)} of ${n(l.voicemailsPerMonth)} voicemails`);
  }
  if (l.knocksPerMonth !== undefined) {
    lines.push(`${n(u.knocks)} of ${n(l.knocksPerMonth)} knocks`);
  }
  return lines;
}

/** The funding card's sentences, from the server's numbers (never hand-written). Pure. */
export function fundingLines(hub: HubInfo): string[] {
  const s = hub.funding?.summary;
  if (!s) return [];
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    `$${n(s.balanceUsd)} in funding`,
    `Every $1/month covers about ${n(s.peoplePerDollarPerMonth)} people`,
    `$${n(s.balanceUsd)} keeps the hub running for ~${n(s.peopleForAYear)} people for a year (or ~${n(s.peopleForSixMonths)} people for 6 months)`,
  ];
}

export const CREDIT = {
  text: "Proudly supported by unsubscribe.llc",
  url: "https://www.unsubscribe.llc/",
};
