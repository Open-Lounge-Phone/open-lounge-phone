import type { EndReason } from "@openloungephone/protocol";

/** Human wording for why a call ended. */
/** Why a call ended, in plain words. `person` = a grown-up, app-to-app call. */
export function endReasonText(reason: EndReason | undefined, person = false): string {
  switch (reason) {
    case "unavailable":
      return "Not taking calls right now";
    case "denied":
      return "Not allowed right now";
    case "voicemail":
      return "It's quiet hours";
    case "busy":
      return "Line is busy";
    case "unreachable":
      return person ? "They're offline — they need the app open" : "Phone is offline";
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

/** Warning for a phone that is running reduced because its USB charger is too weak. */
export function powerWarning(power: { reduced: boolean } | undefined): string | undefined {
  if (!power?.reduced) return undefined;
  return "Weak charger: some features are off. Use a USB-C charger rated 1.5 A or more.";
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

/** One missed call in a line: "2 calls · Today 14:05" (a line's call back: "Called you back"). */
export function missedSummary(
  m: { kind: "call" | "callback"; count: number; at: number; space?: string },
  now: number,
): string {
  const d = new Date(m.at);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day = (t: number) => new Date(t).toDateString();
  const when =
    day(m.at) === day(now)
      ? `Today ${time}`
      : day(m.at) === day(now - 86_400_000)
        ? `Yesterday ${time}`
        : `${d.toLocaleDateString()} ${time}`;
  const what = m.kind === "callback" ? "Called you back" : m.count > 1 ? `${m.count} calls` : "";
  return [what, when, m.space ? `in ${m.space}` : ""].filter(Boolean).join(" · ");
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

/** "Kid phone", "Kid phone and Desk", "A, B and C". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
