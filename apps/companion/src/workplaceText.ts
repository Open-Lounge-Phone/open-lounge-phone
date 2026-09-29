/** Words for team and org spaces' ring groups, hours and audit trail. Pure. */
import type { AfterHours, Directory, HoursRule, HuntStrategy } from "./api.ts";

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

/** One audit entry in words ("set extension 201"). */
export function auditText(action: string, d: Record<string, unknown> | null): string {
  const s = (k: string) => (d && typeof d[k] === "string" ? (d[k] as string) : "");
  switch (action) {
    case "extension.set":
      return `set extension ${s("number")}`;
    case "extension.delete":
      return `removed extension ${s("number")}`;
    case "group.create":
      return `made ring group ${s("name")} (${s("extension")})`;
    case "group.update":
      return "changed a ring group";
    case "group.delete":
      return `deleted ring group ${s("name")}`;
    case "hours.update":
      return "changed business hours";
    case "role.change":
      return `made ${s("name")} ${s("role") === "admin" ? "an admin" : "a member"}`;
    case "invite.create":
      return `invited ${s("name")}`;
    case "member.remove":
      return `removed ${s("name")}`;
    case "privacy.update":
      return "changed privacy settings";
    case "phone.add":
      return `added phone ${s("name")}`;
    case "phone.remove":
      return `removed phone ${s("name")}`;
    case "calls.export":
      return "exported the call log";
    case "recording.update":
      return d?.enabled ? "turned call recording on" : "turned call recording off";
    default:
      return action;
  }
}
