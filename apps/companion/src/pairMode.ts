/** How a phone will be used, chosen when it's claimed (docs/device-lifecycle.md). */
export type PhoneMode = "kids" | "personal" | "lounge";

export const MODE_TEXT: Record<PhoneMode, { title: string; hint: string }> = {
  kids: {
    title: "Kids phone",
    hint: "For a child: only the people you allow, quiet hours, voicemail to you.",
  },
  personal: {
    title: "My own phone",
    hint: "A desk or bedside phone that is always you: your people on its keys.",
  },
  lounge: {
    title: "Lounge phone",
    hint: "Shared: idle until someone scans its code and presses the key it flashes.",
  },
};

/** The modes this person may pick here: kids and Lounge phones are for guardians; kids only at home. */
export function allowedModes(guardian: boolean, kidsAllowed: boolean): PhoneMode[] {
  if (!guardian) return ["personal"];
  return kidsAllowed ? ["kids", "personal", "lounge"] : ["personal", "lounge"];
}

/** Preselect what the phone was set up as, if allowed; else the caller's hint, else the first. */
export function initialMode(
  allowed: PhoneMode[],
  phoneChoice: PhoneMode | null | undefined,
  preferMine: boolean,
): PhoneMode {
  if (phoneChoice && allowed.includes(phoneChoice)) return phoneChoice;
  if (preferMine && allowed.includes("personal")) return "personal";
  return allowed[0] ?? "personal";
}
