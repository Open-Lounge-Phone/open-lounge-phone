/** A phone's firmware in words (the notice, the phone's page). Pure. */
import { buildLabel } from "@openloungephone/core";
import { formatWhen } from "./text.ts";

/** "Mia's phone", or the name as it is when it already says phone. */
export const phoneOf = (name: string) => (/phone/i.test(name) ? name : `${name}'s phone`);

/** The live notice: "Mia's phone is running new firmware: built at home, 'mia-snake 2', today 4:12 pm." */
export function firmwareNotice(
  n: { name: string; project: string; version: string; held: boolean; at: number },
  now: number,
  locale?: string,
): string {
  const when = formatWhen(n.at, now, locale);
  const text = `${phoneOf(n.name)} is running new firmware: built at home, '${buildLabel(n)}', ${when.charAt(0).toLowerCase()}${when.slice(1)}.`;
  return n.held ? `${text} It can't make or take calls until you OK it.` : text;
}

/** Where a build came from, for the phone's page. */
export const buildOrigin = (official: boolean) =>
  official ? "Official update" : "Built at home (not an official update)";
