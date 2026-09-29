// Call recording rules (docs/security-model.md, "Recording"). Pure: shared by the server, the
// apps and the phones. Recording is off unless a space turns it on, never happens in a home with
// kids' phones or on a call with a kids' phone, and is always announced to everyone.

/** The longest recording a client makes (it stops there; the upload takes at most this). */
export const RECORDING_MAX_MS = 2 * 60 * 60 * 1000;

/** Phone models whose client can record (the browser phone and desktop app; not firmware yet). */
export const RECORDING_MODELS: ReadonlySet<string> = new Set(["web-emulator", "desktop"]);

/** What every party hears when recording starts (hardware plays prompt `call.recorded`). */
export const RECORDING_PROMPT = "This call is recorded.";

export type RecordingBlock =
  /** The space hasn't turned recording on (the default). */
  | "off"
  /** A home with kids' phones never records. */
  | "kids_space"
  /** A kids' phone is on the call (or in the room). */
  | "kids_on_call";

/** Whether a space may turn recording on: never a home with kids' phones. */
export function mayEnableRecording(space: {
  type: "home" | "team" | "org";
  kidsPhones: number;
}): { ok: true } | { ok: false; error: string } {
  if (space.type === "home" && space.kidsPhones > 0) {
    return { ok: false, error: "a home with kids' phones can't record calls" };
  }
  return { ok: true };
}

/**
 * Whether this call (or room) is recorded by its space. Only a space that turned recording on,
 * that has no kids' phones, and only when no kids' phone takes part.
 */
export function recordingDecision(input: {
  enabled: boolean;
  spaceKidsPhones: number;
  kidsPhoneOnCall: boolean;
}): { record: true } | { record: false; why: RecordingBlock } {
  if (!input.enabled) return { record: false, why: "off" };
  if (input.spaceKidsPhones > 0) return { record: false, why: "kids_space" };
  if (input.kidsPhoneOnCall) return { record: false, why: "kids_on_call" };
  return { record: true };
}

/** A party as the recording side sees it. */
export interface RecordingParty {
  id: string;
  /** On this side (an app or a phone of this space's hub), not someone on another server. */
  local: boolean;
  /** Its client can record (apps and the browser phone; firmware says so in its hello). */
  canRecord: boolean;
  /** Rooms: the host. */
  host?: boolean;
}

/**
 * Who makes the recording: the recording side's own client — the host if they can, else the
 * first local party that can. Nobody (undefined) if no local client can: then nothing is
 * recorded, though the announcement still stands.
 */
export function pickRecorder(parties: readonly RecordingParty[]): string | undefined {
  const able = parties.filter((p) => p.local && p.canRecord);
  return (able.find((p) => p.host) ?? able[0])?.id;
}
