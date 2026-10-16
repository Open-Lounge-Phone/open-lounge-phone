// A kids' phone's call activity (Manage → Call activity, guardians): each call in plain words.
import { formatDuration } from "./text.ts";

/** One row as the server sends it (`GET /devices/:id/calls`). */
export interface ActivityRow {
  id: string;
  cursor: string;
  at: number;
  direction: "in" | "out";
  who: string;
  answered: boolean;
  durationMs: number;
  /** How it ended (`hangup`, `declined`, `timeout`, …). */
  ended: string | null;
  /** It never rang: why. */
  refused?: "not_allowed" | "quiet_hours" | "busy" | "offline" | "unavailable" | "other";
  /** The words the caller was given, if any. */
  note?: string;
  /** The caller left a voicemail (it's in Voicemail). */
  voicemail: boolean;
}

/** The headline and the detail line for one call ("Mom called" / "Answered · 3:12"). */
export function activityText(r: ActivityRow): { title: string; detail: string } {
  const who = r.who.trim() || "Someone";
  const title = r.refused
    ? r.direction === "in"
      ? `${who} tried to call`
      : `Tried to call ${who}`
    : r.direction === "in"
      ? r.answered
        ? `${who} called`
        : `Missed call from ${who}`
      : `Called ${who}`;
  const vm = r.voicemail ? " · left a voicemail" : "";
  if (r.answered) return { title, detail: `Answered · ${formatDuration(r.durationMs)}` };
  if (r.refused) return { title, detail: `${refusedText(r)}${vm}` };
  if (r.direction === "in") {
    return { title, detail: `${r.ended === "declined" ? "Declined" : "Not answered"}${vm}` };
  }
  return {
    title,
    detail:
      r.ended === "declined"
        ? `${who} declined`
        : r.ended === "hangup"
          ? "Hung up before an answer"
          : "No answer",
  };
}

function refusedText(r: ActivityRow): string {
  const into = r.direction === "in";
  switch (r.refused) {
    case "not_allowed":
      return into ? "Not on the phone's list" : "Not allowed from this phone";
    case "quiet_hours":
      return into ? "Quiet hours: it didn't ring" : "Quiet hours";
    case "busy":
      return into ? "The phone was busy" : `${r.who || "They"} were busy`;
    case "offline":
      return into ? "The phone was offline" : `${r.who || "They"} couldn't be reached`;
    case "unavailable":
      return into ? "Not taking calls" : `${r.who || "They"} weren't taking calls`;
    default:
      return r.note ? r.note : "It didn't go through";
  }
}
