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

/**
 * Where an add-on is linked: "Linked to Jesse (jesse@hub.example), in Jesse's home, on
 * hub.example." (an older server doesn't say whose; then only the space).
 */
export function linkedText(a: {
  space: string;
  owner?: { name: string; address: string } | undefined;
  server?: string | undefined;
}): string {
  const who = a.owner ? `${a.owner.name} (${a.owner.address})` : "you";
  const where = a.space ? `, in ${a.space}` : "";
  const on = a.server ? `, on ${a.server}` : "";
  return `Linked to ${who}${where}${on}.`;
}

/** What removing an add-on takes with it, said before and after. */
export function removalText(a: {
  name: string;
  shares: { label: string; holders: unknown[] }[];
}): string {
  const people = a.shares.reduce((n, s) => n + s.holders.length, 0);
  const shares = a.shares.length;
  const parts = [`${a.name} is cut off at once and its address stops working`];
  if (shares) {
    parts.push(
      `its ${shares === 1 ? "share" : `${shares} shares`} (${a.shares.map((s) => s.label).join(", ")}) ${
        shares === 1 ? "goes" : "go"
      }${people ? `, and the ${people === 1 ? "person" : `${people} people`} you gave ${shares === 1 ? "it" : "them"} to ${people === 1 ? "loses" : "lose"} ${shares === 1 ? "it" : "them"}` : ""}`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** A note that something went (`GET /addons/gone`). */
export interface GoneNote {
  id: string;
  what: "removed";
  addon: string;
  at: number;
  shares: { label: string; holders: string[] }[];
}

/**
 * Why a share you hold doesn't work (or went), as the server says it: add-ons off here or on the
 * add-on's server, its owner suspended, not connected any more, or why it went.
 */
export type HeldStopped =
  | "addons_off_here"
  | "addons_off_there"
  | "suspended"
  | "not_connected"
  | "removed"
  | "taken_back"
  | "not_offered"
  | "gone";

/** The plain reason under a stopped share ("You're no longer connected with Jesse."). */
export function stoppedText(why: HeldStopped, owner: string): string {
  switch (why) {
    case "addons_off_here":
      return "Stopped: add-ons are off on this server.";
    case "addons_off_there":
      return "Stopped: add-ons are off on that server.";
    case "suspended":
      return `Stopped: ${owner}'s account is suspended.`;
    case "not_connected":
      return `Stopped: you're no longer connected with ${owner}.`;
    case "removed":
      return `Gone: ${owner} removed the add-on.`;
    case "taken_back":
      return `Gone: ${owner} took it back.`;
    case "not_offered":
      return "Gone: the add-on doesn't offer it any more.";
    case "gone":
      return `Gone: ${owner}'s server doesn't list it any more.`;
  }
}

/** "seat was removed. Its share Book club went; Ana and Bob no longer have it." */
export function goneText(n: GoneNote): string {
  const given = n.shares.filter((s) => s.holders.length);
  const parts = [`${n.addon} was removed and its address stopped working.`];
  if (n.shares.length) {
    parts.push(
      `${n.shares.length === 1 ? "Its share" : "Its shares"} ${n.shares.map((s) => s.label).join(", ")} went${
        given.length
          ? `; ${[...new Set(given.flatMap((s) => s.holders))].join(", ")} no longer ${
              new Set(given.flatMap((s) => s.holders)).size === 1 ? "has" : "have"
            } ${n.shares.length === 1 ? "it" : "them"}`
          : ""
      }.`,
    );
  }
  return parts.join(" ");
}
