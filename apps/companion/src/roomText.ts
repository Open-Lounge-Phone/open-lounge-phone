// Words for rooms in the app.

/** "Mom, Dad and 2 others" / "Nobody's in". */
export function whoIsIn(people: readonly string[]): string {
  if (people.length === 0) return "Nobody's in";
  if (people.length === 1) return `${people[0]} is in`;
  if (people.length <= 3) {
    return `${people.slice(0, -1).join(", ")} and ${people.at(-1)} are in`;
  }
  return `${people.slice(0, 2).join(", ")} and ${people.length - 2} others are in`;
}

/** Seconds left before an idle drop, for the warning. */
export function idleSecondsLeft(dropAt: number, now: number): number {
  return Math.max(0, Math.ceil((dropAt - now) / 1000));
}

/** A room's kind in words. */
export function roomKindText(kind: "party" | "phone" | "call"): string {
  return kind === "party" ? "Party line" : kind === "phone" ? "Phone room" : "3-way call";
}

/** A scheduled room's state in words: "Open until 21:00" or "Opens Fri 19:00" (none: always). */
export function roomHoursText(
  r: { hours: unknown[] | null; open: boolean; until?: number; opens?: string },
  time: (ms: number) => string = (ms) =>
    new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string | undefined {
  if (!r.hours?.length) return undefined;
  if (!r.open) return r.opens ?? "Closed";
  return r.until !== undefined ? `Open until ${time(r.until)}` : "Open";
}
