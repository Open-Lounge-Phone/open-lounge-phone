import type { EndReason } from "@opentincan/protocol";

/** Human wording for why a call ended. */
export function endReasonText(reason: EndReason | undefined): string {
  switch (reason) {
    case "denied":
      return "Not allowed right now";
    case "voicemail":
      return "It's quiet hours";
    case "busy":
      return "Line is busy";
    case "unreachable":
      return "Phone is offline";
    case "timeout":
      return "No answer";
    case "declined":
      return "Call declined";
    case "error":
      return "Call failed";
    default:
      return "Call ended";
  }
}

export function formatBattery(b: { pct: number; charging: boolean } | undefined): string {
  if (!b) return "";
  return `${b.pct}%${b.charging ? " ⚡" : ""}`;
}

export function formatLastSeen(ts: number | null | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type TranscriptStatus = "pending" | "done" | "failed" | "unavailable";

/** What to show where a voicemail transcript goes. */
export function transcriptText(status: TranscriptStatus, text: string | null): string {
  switch (status) {
    case "pending":
      return "Transcribing…";
    case "done":
      return text?.trim() ? text.trim() : "(no words detected)";
    case "failed":
      return "Couldn't transcribe this message";
    case "unavailable":
      return "No transcript";
  }
}

/** "Today 7:42 PM", "Yesterday 8:05 AM", or a date, in the viewer's locale. */
export function formatWhen(ts: number, now: number, locale?: string): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
}
