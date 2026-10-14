// Words and checks for add-ons in the app (Settings → Add-ons). Pure.

/** The name after `+`: like a handle (2–30 of a-z, 0-9, dot, dash, underscore). */
const NAME_RE = /^[a-z0-9._-]{2,30}$/;

/** What's wrong with a name for a new add-on, in words; undefined when it's fine. */
export function addonNameProblem(name: string): string | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return "Give it a name, like seat.";
  if (!NAME_RE.test(n)) return "Use 2 to 30 letters, digits, dots, dashes or underscores.";
  return undefined;
}

/** The address a new add-on will have: `handle+name@host`, from your own `handle@host`. */
export function addonPreview(address: string | undefined, name: string): string | undefined {
  const n = name.trim().toLowerCase();
  const at = address?.lastIndexOf("@") ?? -1;
  if (!address || at <= 0 || !NAME_RE.test(n)) return undefined;
  return `${address.slice(0, at)}+${n}${address.slice(at)}`;
}

/** Whether an address (from a call log, say) is an add-on's: `handle+name@host`. */
export const isAddonAddress = (address: string): boolean => /^[^@+\s]+\+[^@\s]+@/.test(address);

/** What's wrong with an add-on address someone typed, in words; undefined when it's fine. */
export function addonAddressProblem(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return "Type the add-on's address.";
  const m = /^([a-z0-9._-]{2,30})\+([a-z0-9._-]{2,30})@([a-z0-9.-]+(:\d{1,5})?)$/.exec(t);
  if (!m) return "That isn't an add-on's address. It looks like name+seat@example.org.";
  return undefined;
}
