// Which list on Home each phone of the space goes in. Every phone lands in exactly one, so none
// can vanish: mine (all of them), the household's, other people's own phones, Lounge phones.
import type { DeviceSummary } from "./api.ts";

type Phone = Pick<DeviceSummary, "id" | "ownerUserId" | "kind">;

export interface PhoneLists<T extends Phone> {
  /** Every phone of mine (a desk phone, a virtual one…). */
  mine: T[];
  /** Household phones nobody owns (e.g. kids'). */
  household: T[];
  /** Other people's own phones (guardians manage them). */
  theirs: T[];
  /** Shared Lounge phones. */
  lounge: T[];
}

export function phoneLists<T extends Phone>(devices: readonly T[], meId?: string): PhoneLists<T> {
  const out: PhoneLists<T> = { mine: [], household: [], theirs: [], lounge: [] };
  for (const d of devices) {
    if (d.kind === "lounge") out.lounge.push(d);
    else if (!d.ownerUserId) out.household.push(d);
    else if (meId && d.ownerUserId === meId) out.mine.push(d);
    else out.theirs.push(d);
  }
  return out;
}
