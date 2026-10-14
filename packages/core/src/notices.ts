// Notices (docs/notices.md): a short message from a space's owner, admins or guardians to its
// phones ("BUS IS HERE", "KITCHEN CLOSES AT 10"), with an optional recording. The rules for the
// text and for which notice a phone shows live here, pure; the server passes in what it stored.

/** Characters per line: what the phones' screens show. */
export const NOTICE_LINE_CHARS = 16;
/** How long a notice lasts unless the poster chooses otherwise. */
export const NOTICE_DEFAULT_MINUTES = 60;
export const NOTICE_MAX_MINUTES = 24 * 60;
/** The longest recording on a notice. */
export const NOTICE_AUDIO_MAX_MS = 30_000;

/**
 * The lines of a notice from what someone typed: one or two lines (a line break splits them),
 * each trimmed, at most 16 characters of plain text, in capitals as the screens show them. An
 * error in words
 * when it doesn't fit.
 */
export function noticeLines(text: string): { lines: string[] } | { error: string } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, " ").toUpperCase())
    .filter(Boolean);
  if (!lines.length) return { error: "write a notice" };
  if (lines.length > 2) return { error: "at most two lines" };
  if (lines.some((l) => l.length > NOTICE_LINE_CHARS)) {
    return { error: `at most ${NOTICE_LINE_CHARS} characters a line` };
  }
  // The phones' screens have letters, digits and plain punctuation (no emoji or accents).
  if (lines.some((l) => /[^ -~]/.test(l))) {
    return { error: "use letters, digits and plain punctuation" };
  }
  return { lines };
}

/** A stored notice, as far as choosing what a phone shows goes. */
export interface NoticeEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** Taken down early. */
  endedAt: number | null;
  /** Only these phones; null = every phone in the space. */
  deviceIds: string[] | null;
}

/** Whether a notice is up at `now` (not expired, not taken down). */
export const noticeLive = (n: NoticeEntry, now: number) => n.endedAt === null && n.expiresAt > now;

/**
 * The notice a phone shows at `now`: the newest live one meant for it that it hasn't dismissed
 * (a newer notice replaces an older one, so a dismissed newest one shows nothing).
 */
export function noticeFor<N extends NoticeEntry>(
  notices: readonly N[],
  deviceId: string,
  dismissed: ReadonlySet<string>,
  now: number,
): N | undefined {
  const mine = notices
    .filter((n) => noticeLive(n, now) && (!n.deviceIds || n.deviceIds.includes(deviceId)))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const newest = mine[0];
  return newest && !dismissed.has(newest.id) ? newest : undefined;
}

/** The next time a notice expires (to take it off the phones then). */
export function nextNoticeExpiry(notices: readonly NoticeEntry[], now: number): number | undefined {
  let at: number | undefined;
  for (const n of notices) {
    if (noticeLive(n, now)) at = at === undefined ? n.expiresAt : Math.min(at, n.expiresAt);
  }
  return at;
}
