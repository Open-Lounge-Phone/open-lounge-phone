/**
 * The header dot mirrors a phone's status LED (same colours as apps/device-web/src/leds.ts):
 * green ready, red offline, purple quiet hours, blue pulse ringing, grey no phone. Which phone:
 * your own phone; otherwise (guardians) the first household phone.
 */

export type LedColor = "green" | "red" | "purple" | "blue" | "grey";

export interface PhoneRef {
  id: string;
  name: string;
  online: boolean;
  ownerUserId?: string | null;
}

export interface PhoneLed {
  color: LedColor;
  pulse: boolean;
  label: string;
  /** The phone shown, for navigation; undefined when there is none. */
  deviceId?: string;
  mine: boolean;
}

export function pickPhone(
  devices: readonly PhoneRef[],
  meId: string | undefined,
  guardian: boolean,
): { device: PhoneRef; mine: boolean } | undefined {
  const mine = devices.find((d) => meId && d.ownerUserId === meId);
  if (mine) return { device: mine, mine: true };
  const household = guardian ? devices.find((d) => !d.ownerUserId) : undefined;
  return household ? { device: household, mine: false } : undefined;
}

export interface PhoneLedInput {
  devices: readonly PhoneRef[];
  /** Live online state from `device.status`, overriding the listed value. */
  live: Readonly<Record<string, { online: boolean }>>;
  meId: string | undefined;
  guardian: boolean;
  /** Household quiet hours in effect now (own phones ignore them). */
  quietNow: boolean;
  /** A call is ringing for you right now. */
  ringing: boolean;
}

export function phoneLed(input: PhoneLedInput): PhoneLed {
  const picked = pickPhone(input.devices, input.meId, input.guardian);
  if (!picked) return { color: "grey", pulse: false, label: "No phone yet", mine: false };
  const { device, mine } = picked;
  const who = device.name;
  const online = input.live[device.id]?.online ?? device.online;
  const base = { deviceId: device.id, mine };
  if (!online) {
    return { ...base, color: "red", pulse: false, label: `${who}: offline — tap to open it` };
  }
  if (input.ringing) return { ...base, color: "blue", pulse: true, label: `${who}: ringing` };
  if (!mine && input.quietNow) {
    return { ...base, color: "purple", pulse: false, label: `${who}: quiet hours` };
  }
  return { ...base, color: "green", pulse: false, label: `${who}: online` };
}

/** Opens the virtual phone for `userId` (pairs itself on first open). */
export function virtualPhoneUrl(userId: string, name: string, pair: boolean): string {
  const q = new URLSearchParams({ profile: `me-${userId}` });
  if (pair) {
    q.set("autopair", "1");
    q.set("forMe", "1");
    q.set("name", `${name}'s phone`.slice(0, 24));
  }
  return `/device/?${q.toString()}`;
}

/** Shown on an offline phone's card: why a virtual phone goes offline, and what to do. */
export const OFFLINE_HINT =
  "Offline — a virtual phone only stays connected while its page is open and visible. On iPhone, open it on another device (a laptop or tablet) and leave it there.";

/**
 * Link to open your virtual phone on another device. If that browser is signed in to this
 * server it pairs itself as your phone; otherwise it shows a code to pair from here.
 */
export function shareLink(origin: string, userId: string, name: string): string {
  return `${origin.replace(/\/$/, "")}${virtualPhoneUrl(userId, name, true)}`;
}

/** Guardians manage every phone; anyone manages their own phone. */
export function canManage(
  device: { ownerUserId?: string | null },
  meId: string | undefined,
  guardian: boolean,
): boolean {
  return guardian || (!!meId && device.ownerUserId === meId);
}
