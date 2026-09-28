/**
 * First-run setup of a browser phone: which phone this device plays, remembered per profile,
 * and which start screen to show. On an old phone or tablet the page needs one tap before it can
 * make sound or use the microphone, so every launch starts with a screen. Pure.
 */
import type { Variant } from "./power.ts";

export const kindKey = (profile: string) => `olp-phone-kind:${profile}`;

type Get = Pick<Storage, "getItem">;
type Set = Pick<Storage, "setItem">;

/** `?variant=` wins (developer override), then the stored choice; undefined = not chosen yet. */
export function loadKind(
  storage: Get | undefined,
  profile: string,
  param: string | null,
): Variant | undefined {
  if (param === "lounge" || param === "kids") return param;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(kindKey(profile)) ?? null;
  } catch {
    // Storage can be blocked (private mode); the phone then asks again next launch.
  }
  return stored === "lounge" || stored === "kids" ? stored : undefined;
}

export function saveKind(storage: Set | undefined, profile: string, kind: Variant): void {
  try {
    storage?.setItem(kindKey(profile), kind);
  } catch {}
}

export type StartScreen =
  /** First run: pick "Kids phone" or "Lounge phone" (the tap also unlocks audio). */
  | "choose"
  /** Later launches: one tap to allow sound and the microphone. */
  | "tap"
  | "none";

export function startScreen(input: {
  kind: Variant | undefined;
  /** Already paired (a device id is stored): the kind can no longer be chosen here. */
  paired: boolean;
  /** The user has tapped since the page loaded. */
  started: boolean;
}): StartScreen {
  if (input.started) return "none";
  if (!input.kind && !input.paired) return "choose";
  return "tap";
}
