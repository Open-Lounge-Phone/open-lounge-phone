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
  const m =
    /^([a-z0-9._-]{2,30})\+([a-z0-9._-]{2,30})(\+[a-z0-9-]{1,30})?@([a-z0-9.-]+(:\d{1,5})?)$/.exec(
      t,
    );
  if (!m) return "That isn't an add-on's address. It looks like name+seat@example.org.";
  return undefined;
}

/** The name an add-on's call goes by in the app: `seat`, or `seat · Book club` within a share. */
export const addonCallLabel = (name: string, share?: string): string =>
  share ? `${name} · ${share}` : name;

/** A share someone gave you, as you see it: "Jesse's seat · Book club". */
export const heldShareLabel = (owner: string, addon: string, share: string): string =>
  `${owner}'s ${addon} · ${share}`;

/** Where "New shared project with…" stands, in words. */
export function shareRequestText(
  addon: string,
  r: { state: string; label: string; reason?: string; people: string[] },
): string {
  switch (r.state) {
    case "waiting":
      return `Asking ${addon} to make ${r.label}…`;
    case "created":
      return r.people.length
        ? `Done. ${r.label} is shared with ${r.people.join(", ")}.`
        : `Done. ${addon} made ${r.label}.`;
    case "refused":
      return `${addon} didn't make it: ${r.reason ?? "no reason given"}`;
    case "offline":
      return `${addon} is offline, so it wasn't asked. Try again when it's connected.`;
    default:
      return `${addon} didn't answer. Try again later.`;
  }
}
