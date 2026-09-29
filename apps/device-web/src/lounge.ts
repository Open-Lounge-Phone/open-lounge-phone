/**
 * What a Lounge phone shows: the takeover QR code while it's free, "press the glowing key"
 * during the proximity proof, and "Hi <name>" while someone uses it. Pure, so firmware can
 * mirror it.
 */
import type { DeviceState } from "@openloungephone/core";
import { digitOf } from "./keypad.ts";
import { STATUS_WIDTH, type StatusLines } from "./strip.ts";

export interface LoungeView {
  /** Current takeover nonce (rotates every minute and after each use). */
  nonce?: { nonce: string; expiresAt: number };
  /** Someone scanned the code: the key (button index) they must press. */
  challenge?: { index: number; expiresAt: number };
  /** Who is using the phone. Forgotten when the session ends. */
  session?: { name: string; openToChat: boolean };
  /** Nobody signed in: the space gave idle phones house-line keys (they call as the space). */
  houseLine?: boolean;
  /** Nobody signed in: "who's here" (people open to chat at the space's other Lounge phones). */
  here?: { name: string; where: string }[];
}

/** The link in the QR code; the companion's /lounge page reads the hash. */
export function loungeUrl(origin: string, deviceId: string, nonce: string): string {
  return `${origin}/lounge#${deviceId}.${nonce}`;
}

const clip = (s: string) => s.toUpperCase().slice(0, STATUS_WIDTH);

/** Status lines for a Lounge phone, or undefined to use the normal call status. */
export function loungeLines(view: LoungeView, state: DeviceState): StatusLines | undefined {
  if (view.challenge) return [clip(`PRESS KEY ${digitOf(view.challenge.index)}`), "TO START"];
  if (state.kind !== "idle" && state.kind !== "offhook") return undefined;
  if (view.session) {
    if (state.kind === "offhook") return undefined;
    return [
      clip(`HI ${view.session.name}`),
      view.session.openToChat ? "OPEN TO CHAT" : "MENU = OPTIONS",
    ];
  }
  const [someone] = view.here ?? [];
  if (someone) return ["SCAN TO USE", clip(`HERE: ${someone.name}`)];
  return ["SCAN TO USE", view.houseLine ? "OR PRESS A KEY" : "THIS PHONE"];
}

/** Ask for a new code this long before the current one expires. */
export const QR_REFRESH_LEAD_MS = 5_000;

/** The code's place on screen: the phone is idle (a new takeover ends the current session). */
function codeScreen(view: LoungeView, state: DeviceState, menuOpen: boolean): boolean {
  return !view.challenge && state.kind === "idle" && !menuOpen;
}

/** The QR code shows while the phone is idle and its code is still valid. */
export function showQr(
  view: LoungeView,
  state: DeviceState,
  menuOpen: boolean,
  now: number,
): boolean {
  return !!view.nonce && view.nonce.expiresAt > now && codeScreen(view, state, menuOpen);
}

/**
 * Whether to send `lounge.refresh`: only while the code is actually on a visible screen and it
 * is missing or about to expire. The server never pushes codes on a timer, so this is all an
 * unused Lounge phone ever costs it.
 */
export function wantsFreshCode(
  view: LoungeView,
  state: DeviceState,
  menuOpen: boolean,
  now: number,
  visible: boolean,
): boolean {
  if (!visible || !codeScreen(view, state, menuOpen)) return false;
  return !view.nonce || view.nonce.expiresAt - now < QR_REFRESH_LEAD_MS;
}

/**
 * Key digits a free Lounge phone can dial: none until someone takes it over, unless the space
 * gave it house-line keys.
 */
export function loungeKeysLive(view: LoungeView): boolean {
  return !!view.session || !!view.houseLine;
}
