/** A space is a household (`home`), a `team` or an `org`; the UI keeps "household" for homes. */
export type SpaceType = "home" | "team" | "org";

/** The word for a space of this type, e.g. "household" for a home. */
export function spaceNoun(type: SpaceType | undefined): string {
  if (type === "team") return "team";
  if (type === "org") return "organization";
  return "household";
}

/** Kids' phones and quiet hours exist only in homes. */
export const kidSafe = (type: SpaceType | undefined): boolean => (type ?? "home") === "home";

/** A role's name: guardian/contact in a home, admin/member in a team or org. */
export function roleNoun(role: "guardian" | "contact", type: SpaceType | undefined): string {
  if (kidSafe(type)) return role === "guardian" ? "Guardian" : "Contact";
  return role === "guardian" ? "Admin" : "Member";
}
