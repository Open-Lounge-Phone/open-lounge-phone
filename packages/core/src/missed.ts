// Missed calls on a phone's screen (docs/phone-ux.md "Missed calls"): when each one was, in the
// space's local time. Pure; firmware mirrors it (`missed_when` in firmware/main/strip.c).

const DAY_MS = 86_400_000;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/**
 * When a missed call was, for a 20-character line: `14:05` today, `YESTERDAY 09:12`, or
 * `12 OCT 18:30` before that. `offsetMin` is the space's UTC offset (`config.utcOffsetMin`).
 */
export function missedWhen(at: number, now: number, offsetMin: number): string {
  const local = at + offsetMin * 60_000;
  const day = Math.floor(local / DAY_MS);
  const today = Math.floor((now + offsetMin * 60_000) / DAY_MS);
  const d = new Date(local);
  const time = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (day === today) return time;
  if (day === today - 1) return `YESTERDAY ${time}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${time}`;
}

/** The second line of a missed call on the Missed screen: how many and when. */
export function missedCountLine(
  m: { kind?: "voicemail" | "call"; callback?: true; count?: number },
  when: string,
): string {
  if (m.callback) return `CALLED BACK ${when}`;
  const n = m.count ?? 1;
  return n > 1 ? `${n} CALLS ${when}` : when;
}
