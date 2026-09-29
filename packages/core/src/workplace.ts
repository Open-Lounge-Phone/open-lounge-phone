// Team and org spaces as a workplace phone system: roles, extensions, ring (hunt) groups and
// business hours. Pure: the server passes `now` in, and phones and apps share the rules.
import type { WorkplacePrompt } from "@openloungephone/protocol";
import { isQuietAt, type QuietHoursRule, type Weekday } from "./quietHours.ts";

/** What the team/org phone prompts say (the browser phone speaks them; hardware plays the ids). */
export const WORKPLACE_PROMPT_TEXT: Record<WorkplacePrompt, string> = {
  "ext.enter": "Enter the extension, then press menu.",
  "ext.unknown": "There's no such extension.",
  "ext.closed": "We're closed right now. Please leave a message.",
};

/** The server's `call.state` notes for an extension that doesn't exist and a closed group. */
export const NO_EXTENSION_NOTE = "No such extension";
export const CLOSED_NOTE = "Closed right now";

/** Extensions are short numbers, unique per space: 2 to 6 digits (e.g. 201, 4400). */
export const EXTENSION_RE = /^[0-9]{2,6}$/;
export const isExtension = (s: string): boolean => EXTENSION_RE.test(s);

/**
 * A person's role in a team or org space. Stored as the membership role: `guardian` = admin,
 * `contact` = member; the owner is the space's first admin (who made it). Homes keep their
 * guardian/contact wording.
 */
export type SpaceRole = "owner" | "admin" | "member";

export function spaceRole(role: "guardian" | "contact", isOwner: boolean): SpaceRole {
  if (role !== "guardian") return "member";
  return isOwner ? "owner" : "admin";
}

/** Which role changes a person may make: only the owner promotes or demotes, never themselves. */
export function mayChangeRole(
  actor: SpaceRole,
  target: SpaceRole,
  to: "admin" | "member",
): { ok: true } | { ok: false; error: string } {
  if (actor !== "owner") return { ok: false, error: "only the owner changes roles" };
  if (target === "owner") return { ok: false, error: "the owner stays the owner" };
  if ((target === "admin") === (to === "admin")) return { ok: false, error: "no change" };
  return { ok: true };
}

export type HuntStrategy = "simultaneous" | "sequential" | "round_robin";

/**
 * The steps a call to a ring group rings, in order: each step rings its members at once for the
 * group's ring time; after the last step the call goes to the group's voicemail. Simultaneous =
 * one step with everyone; sequential = one member per step in list order; round robin = the
 * same, starting at `nextIndex` (the member after whoever went first last time). Members who
 * can't take a call now (`available` false) are skipped.
 */
export function huntSteps(
  strategy: HuntStrategy,
  members: readonly string[],
  available: (userId: string) => boolean,
  nextIndex = 0,
): string[][] {
  const n = members.length;
  const order =
    strategy === "round_robin" && n > 0
      ? members.map((_, i) => members[(i + (nextIndex % n) + n) % n] as string)
      : [...members];
  const free = order.filter(available);
  if (free.length === 0) return [];
  return strategy === "simultaneous" ? [free] : free.map((m) => [m]);
}

/** Round robin: where the next call starts (after the member who went first this time). */
export function nextRoundRobin(members: readonly string[], firstRung: string): number {
  const i = members.indexOf(firstRung);
  return i < 0 || members.length === 0 ? 0 : (i + 1) % members.length;
}

/** Open windows of a space or group; empty or missing = always open. */
export interface BusinessHours {
  timeZone: string;
  rules: QuietHoursRule[];
}

/** Whether a space or group is open at `now` (the same wall-clock rules as quiet hours). */
export function isOpen(hours: BusinessHours | undefined, now: Date): boolean {
  if (!hours || hours.rules.length === 0) return true;
  return isQuietAt(hours, now);
}

/** A group's hours: its own, else its space's. */
export function effectiveHours<R extends { days: number[]; start: string; end: string }>(
  timeZone: string,
  groupRules: R[] | null,
  spaceRules: R[] | null,
): BusinessHours | undefined {
  const rules = groupRules ?? spaceRules;
  if (!rules?.length) return undefined;
  return {
    timeZone,
    rules: rules.map((r) => ({ days: r.days as Weekday[], start: r.start, end: r.end })),
  };
}

export type AfterHoursAction =
  | { kind: "voicemail" }
  | { kind: "group"; groupId: string }
  | { kind: "user"; userId: string };

/**
 * What a call to a closed group does: the group's own action, else the space's, else its
 * voicemail box. A call that was already forwarded once never forwards again (it goes to the
 * voicemail of the group it reached), so two closed groups can't bounce a call between them.
 */
export function afterHoursAction(
  group: AfterHoursAction | null,
  space: AfterHoursAction | null,
  forwarded: boolean,
  selfId: string,
): AfterHoursAction {
  const action = group ?? space ?? { kind: "voicemail" };
  if (forwarded) return { kind: "voicemail" };
  if (action.kind === "group" && action.groupId === selfId) return { kind: "voicemail" };
  return action;
}

/** A directory search: name, handle or extension, case-insensitive; empty matches all. */
export function directoryMatch(
  query: string,
  entry: { name: string; handle?: string | null; extension?: string | null },
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entry.name.toLowerCase().includes(q) ||
    (entry.handle ?? "").toLowerCase().includes(q) ||
    (entry.extension ?? "").startsWith(q)
  );
}

/** A CSV cell: quoted when needed; a leading =, +, - or @ is defused (spreadsheet formulas). */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
