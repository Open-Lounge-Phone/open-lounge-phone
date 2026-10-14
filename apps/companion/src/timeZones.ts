import { isValidTimeZone } from "@openloungephone/core";

export interface ZoneGroup {
  region: string;
  zones: { value: string; label: string }[];
}

/** "America/Argentina/Buenos_Aires" -> "Buenos Aires, Argentina". */
export function zoneLabel(zone: string): string {
  const parts = zone.split("/").map((p) => p.replace(/_/g, " "));
  if (parts.length === 1) return parts[0] ?? zone;
  const [, ...rest] = parts;
  return rest.reverse().join(", ");
}

/** Every IANA zone the browser knows (plus `current`, which may be an alias), grouped by region. */
export function zoneGroups(known: readonly string[], current: string): ZoneGroup[] {
  const all = new Set(known);
  if (isValidTimeZone(current)) all.add(current);
  const groups = new Map<string, ZoneGroup>();
  for (const value of all) {
    const region = value.includes("/") ? (value.split("/")[0] ?? "Other") : "Other";
    const g = groups.get(region) ?? { region, zones: [] };
    g.zones.push({ value, label: zoneLabel(value) });
    groups.set(region, g);
  }
  for (const g of groups.values()) g.zones.sort((a, b) => a.label.localeCompare(b.label));
  return [...groups.values()].sort((a, b) =>
    a.region === "Other" ? 1 : b.region === "Other" ? -1 : a.region.localeCompare(b.region),
  );
}

/** The browser's list of zones, or none when it can't list them (older browsers). */
export function knownZones(): string[] {
  try {
    const list = (Intl as { supportedValuesOf?(key: string): string[] }).supportedValuesOf?.(
      "timeZone",
    );
    return list ?? [];
  } catch {
    return [];
  }
}

/** Why a typed zone won't do, or undefined when it's fine. */
export function zoneProblem(zone: string): string | undefined {
  const z = zone.trim();
  if (!z) return "Choose a time zone.";
  if (!isValidTimeZone(z)) return "Use a name like America/New_York or Europe/London.";
  return undefined;
}
