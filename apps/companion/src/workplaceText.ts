/** Words for team and org spaces' ring groups, hours, public lines and audit trail. Pure. */
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
    case "line.address":
      return `set a public line's address to ${s("to")}`;
    case "line.enable":
      return `made ${s("address")} public (confirmed the warning)`;
    case "line.disable":
      return `turned public line ${s("address")} off`;
    case "line.update":
      return "changed a public line's settings";
    case "line.delete":
      return `removed public line ${s("handle")}`;
    case "line.greeting":
      return "changed a public line's greeting";
    case "line.block":
      return `blocked ${s("value")} from the public lines`;
    case "line.unblock":
      return `unblocked ${s("value")}`;
    default:
      return action;
  }
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
