import type { Retention, TimelineItem } from "./api.ts";
import { formatDuration } from "./text.ts";

/** A call in someone's timeline, in plain words ("Missed call", "Outgoing call · 3:05"). */
export function callLine(item: Extract<TimelineItem, { kind: "call" }>): string {
  if (item.answered) {
    const which = item.direction === "in" ? "Incoming call" : "Outgoing call";
    return `${which} · ${formatDuration(item.durationMs)}`;
  }
  if (item.direction === "in")
    return item.endReason === "declined" ? "Declined call" : "Missed call";
  switch (item.endReason) {
    case "declined":
      return "Call not answered (declined)";
    case "busy":
      return "Call not answered (busy)";
    case "hangup":
      return "Call cancelled";
    default:
      return "Call not answered";
  }
}

export const RETENTION_LABEL: Record<Exclude<Retention, "default">, string> = {
  "30d": "30 days",
  "1y": "1 year",
  forever: "forever",
};

/** The retention choices for a connection (or the account default), with what "default" means. */
export function retentionOptions(
  inherited: Exclude<Retention, "default">,
  defaultName: string,
): { value: Retention; label: string }[] {
  return [
    { value: "default", label: `${defaultName} (${RETENTION_LABEL[inherited]})` },
    { value: "30d", label: RETENTION_LABEL["30d"] },
    { value: "1y", label: RETENTION_LABEL["1y"] },
    { value: "forever", label: "Forever" },
  ];
}

/**
 * What a connection inherits when set to "default": the account default, else what the server
 * says applies (the space's default, else forever).
 */
export function inheritedRetention(
  account: Retention,
  fallback: Exclude<Retention, "default"> = "forever",
): Exclude<Retention, "default"> {
  return account === "default" ? fallback : account;
}
