import { useMemo } from "react";
import { knownZones, zoneGroups, zoneProblem } from "./timeZones.ts";

/**
 * A time zone field: a list of every zone the browser knows, starting on this device's zone.
 * Browsers that can't list zones get a text field that says what's wrong as you type.
 */
export function TimeZonePicker({
  value,
  onChange,
  hint = "Used for quiet hours.",
}: {
  value: string;
  onChange(zone: string): void;
  hint?: string;
}) {
  const groups = useMemo(() => zoneGroups(knownZones(), value), [value]);
  const problem = zoneProblem(value);
  if (groups.length === 0) {
    return (
      <label>
        Time zone
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem ? true : undefined}
          required
        />
        <span className={problem ? "hint error" : "hint"}>{problem ?? hint}</span>
      </label>
    );
  }
  return (
    <label>
      Time zone
      <select
        value={problem ? "" : value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        required
      >
        {problem && (
          <option value="" disabled>
            Choose…
          </option>
        )}
        {groups.map((g) => (
          <optgroup key={g.region} label={g.region}>
            {g.zones.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className={problem ? "hint error" : "hint"}>{problem ?? hint}</span>
    </label>
  );
}
