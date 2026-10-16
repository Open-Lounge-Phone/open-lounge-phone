import type { DeviceState } from "@openloungephone/core";

/**
 * The status LED's pattern (docs/phone-ux.md; firmware `signals.c`). The minimal board has one red
 * LED and no key lights; it is also the recording light.
 */
export type LedMode =
  | "off"
  | "dim"
  | "on"
  | "pulse"
  | "blink"
  | "ringing"
  | "breathe"
  | "recording"
  /** In a call or a room with the mic muted: a slow double blink. */
  | "muted";

export type Connection = "connecting" | "online" | "offline";

export interface DeviceConfig {
  /** `addon`: the key calls an add-on (shown as one while calling). */
  buttons: { index: number; label: string; addon?: true }[];
  /** Speed-dial pages after the first (`config.pages`): BACK with the handset up turns to them. */
  pages?: { page: number; buttons: { index: number; label: string; addon?: true }[] }[];
  quiet: boolean;
  /** Local "HH:MM" when current quiet hours end. */
  quietUntil?: string;
  /**
   * Missed calls, newest first: callers with unheard voicemail (`kind: "voicemail"`), calls that
   * rang and nobody answered (`kind: "call"`), and public lines whose call back wasn't taken
   * (`callback`); `id` calls one back (MENU 5).
   */
  missed?: {
    from: string;
    callback?: true;
    kind?: "voicemail" | "call";
    at?: number;
    count?: number;
    id?: string;
  }[];
  /** The phone's voicemail greeting, and whether MENU → Voicemail may change it. */
  greeting?: { kind: "default" | "name" | "custom"; canRecord: boolean };
  /** Whose phone this is and how it's used (the strip's trust line). */
  owner?: { mode: "kids" | "personal" | "lounge" | "left"; space: string; person?: string };
  /** A team/org space with extensions: MENU → 6 dials one. */
  extensions?: boolean;
  /** Daily check-in (the ready screen asks for I'm OK until `done`). */
  checkin?: { by: string; done: boolean; alerted?: true };
  /** This phone may post a chime (MENU 4). */
  chime?: { text: string };
}

export interface LedInput {
  deviceState: DeviceState;
  config?: DeviceConfig;
  /** Showing a pairing code. */
  pairing: boolean;
  connection: Connection;
  /** The call or room is announced as recorded. */
  recording?: boolean;
}

/** The status LED for the current phone state. Pure, so firmware can mirror it (`main.c`). */
export function statusLed(input: LedInput): LedMode {
  const { deviceState: s, config, pairing, connection } = input;
  if (pairing || connection === "connecting") return "pulse";
  if (connection === "offline") return "blink";
  if (s.kind === "incoming") return "ringing";
  if ((s.kind === "incall" || s.kind === "inroom") && input.recording) return "recording";
  if ((s.kind === "incall" || s.kind === "inroom") && s.muted) return "muted";
  if (s.kind === "incall" || s.kind === "inroom" || s.kind === "dialing") return "on";
  if (s.kind === "idle" && (config?.missed?.length ?? 0) > 0) return "breathe";
  return "dim";
}

/** True when `next` lists a caller with unheard voicemail that `prev` did not. */
export function hasNewMissed(prev: DeviceConfig | undefined, next: DeviceConfig): boolean {
  const before = new Set(prev?.missed?.map((m) => m.from) ?? []);
  return (next.missed ?? []).some((m) => !before.has(m.from));
}
