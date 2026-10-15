/**
 * The browser phone's missed calls and redial (docs/phone-ux.md "Missed calls", MENU 8): what
 * the Missed screen lists from `config.missed`, and the last call this phone made, remembered
 * per profile like the real phone keeps it across restarts. Pure.
 */
import { type LastDial, missedCountLine, missedWhen } from "@openloungephone/core";
import type { DeviceConfig } from "./leds.ts";
import type { MissedEntry } from "./menu.ts";

type Missed = NonNullable<DeviceConfig["missed"]>[number];

/** A message waiting (an older server sends no `kind`: anything but a call back is one). */
export const isVoicemail = (m: Missed) => m.kind === "voicemail" || (!m.kind && !m.callback);

/** The Missed screen's entries: missed calls and call backs, newest first, with when. */
export function missedEntries(
  config: DeviceConfig | undefined,
  now: number,
  offsetMin: number,
): MissedEntry[] {
  return (config?.missed ?? [])
    .filter((m) => !isVoicemail(m))
    .map((m) => ({
      ...(m.id ? { id: m.id } : {}),
      from: m.from,
      line: missedCountLine(m, missedWhen(m.at ?? now, now, offsetMin)),
    }));
}

export const lastDialKey = (profile: string) => `olp-last-dial:${profile}`;

export function loadLastDial(
  storage: Pick<Storage, "getItem"> | undefined,
  profile: string,
): LastDial | undefined {
  try {
    const v = JSON.parse(storage?.getItem(lastDialKey(profile)) ?? "null") as LastDial | null;
    if (v?.kind === "button" && Number.isInteger(v.index) && v.index >= 0 && v.index < 16) return v;
    if (v?.kind === "extension" && /^\d{2,6}$/.test(v.number)) return v;
    if (v?.kind === "back" && typeof v.id === "string" && v.id) return v;
  } catch {}
  return undefined;
}

export function saveLastDial(
  storage: Pick<Storage, "setItem"> | undefined,
  profile: string,
  last: LastDial,
): void {
  try {
    storage?.setItem(lastDialKey(profile), JSON.stringify(last));
  } catch {}
}

export function forgetLastDial(storage: Pick<Storage, "removeItem"> | undefined, profile: string) {
  try {
    storage?.removeItem(lastDialKey(profile));
  } catch {}
}
