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

// --- friendly presentation (locale-aware, never mixes 12h/24h) ---------------------------

/** "10:30 PM" or "22:30" depending on the viewer's locale. */
export function formatTime(hhmm: string, locale?: string): string {
  const m = minutes(hhmm);
  if (Number.isNaN(m)) return hhmm;
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, Math.floor(m / 60), m % 60));
}

/** "Every day · 10:30 PM → 9:00 AM next morning" */
export function friendlyRule(rule: QuietRule, locale?: string): string {
  const days = describeDays(rule.days);
  if (rule.start === rule.end) return `${days} · all day from ${formatTime(rule.start, locale)}`;
  const next = spansMidnight(rule) ? " next morning" : "";
  return `${days} · ${formatTime(rule.start, locale)} → ${formatTime(rule.end, locale)}${next}`;
}

export const DAY_SHORTCUTS: { label: string; days: number[] }[] = [
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { label: "School nights (Sun–Thu)", days: [0, 1, 2, 3, 4] },
  { label: "Weekdays", days: [1, 2, 3, 4, 5] },
  { label: "Weekends", days: [0, 6] },
];

export const PRESETS: { label: string; rule: QuietRule }[] = [
  {
    label: "Bedtime (Sun–Thu, 8:30 PM–7:00 AM)",
    rule: { days: [0, 1, 2, 3, 4], start: "20:30", end: "07:00" },
  },
  {
    label: "School hours (Mon–Fri, 8:00 AM–3:00 PM)",
    rule: { days: [1, 2, 3, 4, 5], start: "08:00", end: "15:00" },
  },
  { label: "Custom", rule: { days: [0, 1, 2, 3, 4, 5, 6], start: "21:00", end: "07:00" } },
];

/** A shaded span on one weekday row of the week chart, in minutes from midnight. */
export interface Segment {
  from: number;
  to: number;
}

/**
 * Quiet periods per weekday (0 = Sunday) for the "week at a glance" chart. A window that runs
 * past midnight contributes its evening to its start day and its morning to the next day;
 * overlapping spans are merged.
 */
export function weekSegments(rules: QuietRule[]): Segment[][] {
  const week: Segment[][] = Array.from({ length: 7 }, () => []);
  for (const rule of rules) {
    if (validateRule(rule)) continue;
    const s = minutes(rule.start);
    const e = minutes(rule.end);
    for (const d of rule.days) {
      const today = week[d] as Segment[];
      const tomorrow = week[(d + 1) % 7] as Segment[];
      if (s < e) today.push({ from: s, to: e });
      else {
        today.push({ from: s, to: 1440 });
        if (e > 0) tomorrow.push({ from: 0, to: e });
      }
    }
  }
  return week.map((segs) => {
    const sorted = [...segs].sort((a, b) => a.from - b.from);
    const merged: Segment[] = [];
    for (const seg of sorted) {
      const last = merged[merged.length - 1];
      if (last && seg.from <= last.to) last.to = Math.max(last.to, seg.to);
      else merged.push({ ...seg });
    }
    return merged;
  });
}

/** Calendar-day difference between two instants as seen in `timeZone`. */
function dayDiff(a: Date, b: Date, timeZone: string): number {
  const ymd = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
    return Date.parse(`${p}T00:00:00Z`);
  };
  return Math.round((ymd(b) - ymd(a)) / 86_400_000);
}

/** "9:00 AM", "tomorrow at 9:00 AM", "Tuesday at 9:00 AM" — relative to `now`, in `timeZone`. */
export function whenText(at: Date, now: Date, timeZone: string, locale?: string): string {
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(at);
  const diff = dayDiff(now, at, timeZone);
  if (diff === 0) {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(at),
    );
    return hour >= 17 ? `tonight at ${time}` : `today at ${time}`;
  }
  if (diff === 1) return `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(at);
  return `${weekday} at ${time}`;
}
