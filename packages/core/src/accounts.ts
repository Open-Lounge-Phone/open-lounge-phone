// Account sign-in rules shared by the server and the apps: recovery codes, session lifetimes and
// the words for a signed-in device. Pure: randomness and clocks are passed in.

/**
 * Recovery codes: 28 characters of RFC 4648 base32 (140 bits) in seven groups of four,
 * `ABCD-EFGH-…`. Only a hash is stored on the server.
 */
export const RECOVERY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const RECOVERY_CODE_CHARS = 28;
export const RECOVERY_GROUP = 4;

/** Formats random bytes (at least 18) as a recovery code. */
export function recoveryCodeFrom(bytes: Uint8Array): string {
  if (bytes.length * 8 < RECOVERY_CODE_CHARS * 5) throw new Error("not enough random bytes");
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < RECOVERY_CODE_CHARS) {
      out += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return groupRecoveryCode(out);
}

/** `ABCDEFGH…` as `ABCD-EFGH-…`. */
export function groupRecoveryCode(chars: string): string {
  return (chars.match(new RegExp(`.{1,${RECOVERY_GROUP}}`, "g")) ?? []).join("-");
}

/**
 * What someone typed, as the code's 28 characters: case, spaces and dashes don't matter, and
 * the digits people confuse with letters are read as those letters (0 → O, 1 → I, 8 → B).
 * Undefined when it can't be a recovery code.
 */
export function normalizeRecoveryCode(input: string): string | undefined {
  const chars = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/8/g, "B");
  if (chars.length !== RECOVERY_CODE_CHARS) return undefined;
  for (const ch of chars) if (!RECOVERY_ALPHABET.includes(ch)) return undefined;
  return chars;
}

/** The code's last group (people re-type it to show they saved the code). */
export const lastRecoveryGroup = (code: string): string =>
  code.split("-").filter(Boolean).at(-1) ?? "";

/**
 * Compares two strings in time that depends only on their lengths (for secrets' hashes, whose
 * lengths are fixed).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/**
 * Sessions slide: each day a session is used, its end moves to `SESSION_IDLE_MS` after that
 * use. A session that was never backed by a passkey (an invite or sign-in link on a device that
 * made none) does not slide: it ends `SESSION_IDLE_MS` after it started.
 */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60 * 1000;
/** How often a used session's end moves (at most once a day: one write per day of use). */
export const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
/** A session from a recovery code: long enough to make a new passkey, no more. */
export const RECOVERY_SESSION_MS = 30 * 60 * 1000;

/** Whether a session in use at `now` should move its end (see `SESSION_IDLE_MS`). */
export function sessionShouldSlide(
  s: { passkey: boolean; limited: boolean; lastUsedAt: number | null; createdAt: number },
  now: number,
): boolean {
  if (!s.passkey || s.limited) return false;
  return now - (s.lastUsedAt ?? s.createdAt) >= SESSION_REFRESH_MS;
}

/** How a session started (shown in the session list). */
export type SessionVia = "passkey" | "signup" | "setup" | "invite" | "link" | "recovery";

/** A short name for the browser and system in a User-Agent: "Chrome on Mac". */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  const system = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "";
  if (browser && system) return `${browser} on ${system}`;
  return browser || system || "A browser or app";
}
