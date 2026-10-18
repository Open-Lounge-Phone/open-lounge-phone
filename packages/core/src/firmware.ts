// What a phone's firmware change means (docs/security-model.md "Firmware changes"): the server
// keeps each hardware phone's last build and decides here what a new one sets off. Pure: the
// caller stores the result, tells the guardians and holds the phone.

/** The build a phone reports in its `hello` (`PhoneBuild`). */
export interface ReportedBuild {
  sha256: string;
  project: string;
  version: string;
  official: boolean;
}

export interface FirmwareContext {
  /** `web-emulator` and `addon` run what they're served: their builds are never tracked. */
  model: string;
  /** A kids' phone (a home's phone for a child): its guardians are told, and it may be held. */
  kids: boolean;
  /** The phone's Ask me first setting (kids' phones only). */
  askFirst: boolean;
}

export type FirmwareChange =
  /** Nothing to record: a browser phone, or the same image as before. */
  | { kind: "none" }
  /** The first build this server sees for the phone (at pairing): recorded, nothing else. */
  | { kind: "first" }
  /** An official update the phone installed itself: recorded and audited, no alert. */
  | { kind: "official" }
  /**
   * Firmware that isn't an official update (built from source, flashed over USB, or not
   * reported at all): audited; a kids' phone's guardians are told (`notify`) and, with Ask me
   * first, the phone waits for their OK (`hold`).
   */
  | { kind: "changed"; notify: boolean; hold: boolean };

/** Models that report no build of their own: they run whatever the server serves them. */
export const UNTRACKED_MODELS: ReadonlySet<string> = new Set(["web-emulator", "addon"]);

/**
 * A hardware phone that reports no build at all is treated as an unofficial one with no name,
 * so leaving the field out never hides a change.
 */
export const UNREPORTED_BUILD: ReportedBuild = {
  sha256: "",
  project: "unknown",
  version: "unknown",
  official: false,
};

/** What `next` (from this connection's hello) means after `previous` (stored), if any. */
export function firmwareChange(
  previous: { sha256: string } | undefined,
  next: ReportedBuild,
  ctx: FirmwareContext,
): FirmwareChange {
  if (UNTRACKED_MODELS.has(ctx.model)) return { kind: "none" };
  if (!previous) return { kind: "first" };
  if (previous.sha256 === next.sha256) return { kind: "none" };
  if (next.official) return { kind: "official" };
  return { kind: "changed", notify: ctx.kids, hold: ctx.kids && ctx.askFirst };
}

/** The project name official images carry: a label then shows just the version. */
export const OFFICIAL_PROJECT = "openloungephone";

/** How a build is named to people: its version, with the project when it isn't ours. */
export function buildLabel(b: { project: string; version: string }): string {
  return b.project === OFFICIAL_PROJECT ? b.version : `${b.project} ${b.version}`;
}
