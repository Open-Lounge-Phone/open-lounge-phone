import { isQuietAt, nextQuietChange, type Weekday } from "@openloungephone/core";
import type { Schedule } from "./api.ts";
import { whenText } from "./quiet.ts";

export interface QuietStatus {
  quiet: boolean;
  text: string;
}

/** The banner on the quiet-hours screen: what's happening right now and when it changes. */
export function quietStatus(schedule: Schedule, now: Date, locale?: string): QuietStatus {
  if (schedule.rules.length === 0) {
    return { quiet: false, text: "No quiet hours set — phones can ring any time." };
  }
  const core = {
    timeZone: schedule.timeZone,
    rules: schedule.rules.map((r) => ({ ...r, days: r.days as Weekday[] })),
  };
  const quiet = isQuietAt(core, now);
  const next = nextQuietChange(core, now);
  if (quiet) {
    return {
      quiet,
      text: next
        ? `Quiet now — phones stay silent until ${whenText(next, now, schedule.timeZone, locale).replace(/^(today|tonight) at /, "")}.`
        : "Quiet all the time — phones never ring, except for people who ring during quiet hours.",
    };
  }
  return {
    quiet,
    text: next
      ? `Not quiet right now — next quiet time starts ${whenText(next, now, schedule.timeZone, locale)}.`
      : "Not quiet right now.",
  };
}
