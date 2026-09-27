import { isQuietAt, type QuietHoursSchedule } from "./quietHours.ts";

/**
 * A person on a device's allow-list. Anyone not on the list is denied: the device is
 * default-deny in both directions.
 */
export interface Contact {
  id: string;
  label: string;
  /** This contact may call the device. */
  canCallDevice: boolean;
  /** The device may call this contact. */
  deviceCanCall: boolean;
  /** Calls with this contact ignore quiet hours (e.g. parents). */
  bypassQuietHours: boolean;
}

export type InboundDecision =
  | { decision: "ring" }
  | { decision: "voicemail"; reason: "quiet_hours" }
  | { decision: "deny"; reason: "not_allowed" };

export type OutboundDecision =
  | { decision: "dial" }
  | { decision: "deny"; reason: "not_allowed" | "quiet_hours" };

export interface AccessContext {
  quietHours: QuietHoursSchedule;
  now: Date;
}

function quiet(contact: Contact, ctx: AccessContext): boolean {
  return !contact.bypassQuietHours && isQuietAt(ctx.quietHours, ctx.now);
}

/** Someone is calling the device. `contact` is undefined when the caller is not on the list. */
export function authorizeInbound(
  contact: Contact | undefined,
  ctx: AccessContext,
): InboundDecision {
  if (!contact?.canCallDevice) return { decision: "deny", reason: "not_allowed" };
  if (quiet(contact, ctx)) return { decision: "voicemail", reason: "quiet_hours" };
  return { decision: "ring" };
}

/** The device is calling out. During quiet hours the call is refused rather than recorded. */
export function authorizeOutbound(
  contact: Contact | undefined,
  ctx: AccessContext,
): OutboundDecision {
  if (!contact?.deviceCanCall) return { decision: "deny", reason: "not_allowed" };
  if (quiet(contact, ctx)) return { decision: "deny", reason: "quiet_hours" };
  return { decision: "dial" };
}

/** Maps speed-dial button index to contact id. Unmapped buttons resolve to undefined. */
export type ButtonMap = ReadonlyMap<number, string>;

export function resolveButton(
  buttons: ButtonMap,
  contacts: ReadonlyMap<string, Contact>,
  index: number,
): Contact | undefined {
  const id = buttons.get(index);
  return id === undefined ? undefined : contacts.get(id);
}
