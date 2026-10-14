/** Words for team and org spaces' ring groups, hours and public lines. Pure. */
import { ordinal } from "@openloungephone/core";
import type { AfterHours, Directory, HoursRule, HuntStrategy, LineSettings } from "./api.ts";
import type { QueueView } from "./calls.ts";

export const STRATEGY_TEXT: Record<HuntStrategy, string> = {
  simultaneous: "Everyone at once",
  sequential: "One after another",
  round_robin: "Take turns (round robin)",
};

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon–Fri 09:00–17:00"; consecutive days are shortened to a range. */
export function hoursText(rules: HoursRule[] | null): string {
  if (!rules?.length) return "always open";
  return rules
    .map((r) => {
      const days = [...new Set(r.days)].sort();
      const consecutive = days.every((d, i) => i === 0 || d === (days[i - 1] as number) + 1);
      const list =
        days.length > 2 && consecutive
          ? `${DAY[days[0] as number]}–${DAY[days[days.length - 1] as number]}`
          : days.map((d) => DAY[d]).join(", ");
      return `${list} ${r.start}–${r.end}`;
    })
    .join("; ");
}

export function afterHoursText(a: AfterHours | null, dir: Pick<Directory, "groups" | "members">) {
  if (!a) return "as the space says";
  if (a.kind === "voicemail") return "voicemail";
  if (a.kind === "group") {
    return `forward to ${dir.groups.find((g) => g.id === a.groupId)?.name ?? "a group"}`;
  }
  return `forward to ${dir.members.find((m) => m.id === a.userId)?.name ?? "someone"}`;
}

/** Waiting in a public line's queue: "You're 2nd in line", or just "Waiting in line". */
export function queueText(q: QueueView): string {
  if (!q.position) return "Waiting in line";
  if (q.position === 1) return "You're next in line";
  return `You're ${ordinal(q.position)} in line`;
}

/** Who may call a public line, in words. */
export const WHO_TEXT: Record<LineSettings["who"], string> = {
  anyone: "Anyone (on a server you haven't blocked)",
  connections: "Only people connected to someone here",
  allowlist: "Only these servers and addresses",
};

/** What happens at the longest wait, in words. */
export function maxWaitText(
  a: LineSettings["atMaxWait"],
  dir: Pick<Directory, "groups" | "members">,
) {
  if (a.kind === "voicemail") return "offer voicemail";
  if (a.kind === "end") return "end the call";
  return afterHoursText(a, dir);
}
