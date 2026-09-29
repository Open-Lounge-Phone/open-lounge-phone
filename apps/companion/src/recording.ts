/** Voicemail and greeting recording (shared with the browser phone in `@openloungephone/client`). */
export {
  pickRecordingMime,
  type RecorderHandlers,
  type Recording,
  VoicemailRecorder,
} from "@openloungephone/client";

/** A message is up to two minutes. */
export const MAX_RECORDING_MS = 120_000;
