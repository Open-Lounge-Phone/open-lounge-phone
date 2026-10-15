// Words and checks for add-ons in the app (the Add-ons tab). Pure.

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

/** Where "Ask it for a new share…" stands, in words. */
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

/** What an add-on said about itself (`addon.about`), as the app shows it. */
export interface AboutView {
  summary?: string;
  hears: "nothing" | "live" | "keeps";
  transcribes: boolean;
  answers: boolean;
  calls: boolean;
  shares?: boolean;
  keys: boolean;
  lines?: number;
}

/**
 * What an add-on does, in plain sentences, from what it said about itself. Whether it takes calls,
 * calls you, offers shares, takes keys and how many calls at once are held to by the server; what
 * it does with what it hears is its own word, and said so. Nothing here knows any particular
 * add-on.
 */
export function aboutLines(about: AboutView | null | undefined, name: string): string[] {
  if (!about) {
    return [
      `${name} hasn't said what it does.`,
      "You can call it, it may call you, and it can hear what you say.",
    ];
  }
  const out: string[] = [];
  out.push(about.answers ? "You can call it." : "It doesn't take calls.");
  out.push(about.calls ? "It may call you." : "It never calls you.");
  out.push(
    about.hears === "nothing"
      ? "It only plays sound. It says it doesn't use what you say."
      : about.hears === "live"
        ? "It listens during calls. It says it keeps nothing afterwards."
        : "It keeps what it hears: recordings, transcripts or notes.",
  );
  if (about.transcribes && about.hears !== "nothing") out.push("It turns what it hears into text.");
  if (about.keys) out.push("It responds to keys you press during a call.");
  if (about.shares) out.push("It offers parts of itself to share with people you choose.");
  if ((about.lines ?? 1) > 1) out.push(`It takes up to ${about.lines} calls at once.`);
  return out;
}

/** What every caller should know before calling an add-on (or being given one of its shares). */
export const learnsText = (name: string, who: "you" | string = "you"): string =>
  who === "you"
    ? `When you call, ${name} learns your name and address, and can hear what you say.`
    : `When ${who} calls, ${name} learns their name and address, and can hear what they say.`;

/** Its status, in words (the server's view). */
export function addonStatus(
  a: { online: boolean; lastSeen: number | null },
  enabled: boolean,
  when: (ms: number) => string,
): string {
  if (!enabled) return "Off: this server doesn't offer add-ons now";
  if (a.online) return "Online";
  return a.lastSeen
    ? `Offline · last seen ${when(a.lastSeen)}`
    : "Offline · it hasn't connected yet";
}

/** The first free speed-dial slot of a phone (keypad order 1…9, 0), or slot 0 if none is free. */
export function firstFreeSlot(buttons: Record<string, string>, slots: number[]): number {
  return slots.find((s) => !buttons[String(s)]) ?? slots[0] ?? 0;
}

/** A key label for an add-on (phones show up to 24 characters). */
export const keyLabelFor = (label: string): string => label.trim().slice(0, 24);
