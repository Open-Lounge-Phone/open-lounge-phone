/**
 * Handles, as the server checks them (`packages/db` HANDLE_RE): 2–30 of a-z, 0-9, ".", "_", "-".
 * Kept here so the sign-up form can explain problems before asking the server.
 */
const HANDLE_RE = /^[a-z0-9._-]{2,30}$/;

/** A handle suggestion from a name ("José Díaz" → "jose.diaz"); "" when nothing usable. */
export function suggestHandle(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 24)
    .replace(/\.+$/, "");
}

/** What's wrong with a handle, in plain words; undefined when it looks fine. */
export function handleHint(handle: string): string | undefined {
  if (handle.length < 2) return "At least 2 characters.";
  if (handle.length > 30) return "At most 30 characters.";
  if (!HANDLE_RE.test(handle))
    return "Use lower-case letters, digits, dots, dashes or underscores.";
  return undefined;
}

/** Normalizes what someone typed into the handle box. */
export const normalizeHandle = (typed: string): string => typed.trim().toLowerCase();

/** Pulls the invite token out of a pasted link (`…/#invite=<token>`) or a bare token. */
export function inviteTokenFrom(pasted: string): string | undefined {
  const text = pasted.trim();
  if (!text) return undefined;
  const hash = text.includes("#") ? text.slice(text.indexOf("#") + 1) : "";
  const fromLink = new URLSearchParams(hash).get("invite")?.trim();
  if (fromLink) return fromLink;
  return /^[A-Za-z0-9_-]{16,128}$/.test(text) ? text : undefined;
}
