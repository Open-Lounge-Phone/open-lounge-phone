import type { QuietRule } from "./api.ts";

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Returns an error message, or undefined if the rule is valid. */
export function validateRule(rule: QuietRule): string | undefined {
  if (rule.days.length === 0) return "Pick at least one day";
  if (rule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "Invalid day";
  if (!HHMM.test(rule.start)) return "Start time must be HH:MM";
  if (!HHMM.test(rule.end)) return "End time must be HH:MM";
  return undefined;
}

/** An end at or before the start runs past midnight into the next day. */
export function spansMidnight(rule: QuietRule): boolean {
  return minutes(rule.end) <= minutes(rule.start);
}

/** "Mon–Fri", "Sun, Wed", "Every day". Runs of 3+ consecutive days collapse to a range. */
export function describeDays(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) j++;
    const from = DAY_LABELS[sorted[i] as number];
    const to = DAY_LABELS[sorted[j] as number];
    if (j - i >= 2) parts.push(`${from}–${to}`);
    else for (let k = i; k <= j; k++) parts.push(DAY_LABELS[sorted[k] as number] ?? "");
    i = j + 1;
  }
  return parts.join(", ");
}

export function describeRule(rule: QuietRule): string {
  if (rule.start === rule.end) return `${describeDays(rule.days)}, all day from ${rule.start}`;
  const next = spansMidnight(rule) ? " (next day)" : "";
  return `${describeDays(rule.days)} ${rule.start}–${rule.end}${next}`;
}

export function toggleDay(days: number[], day: number): number[] {
  return days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b);
}
