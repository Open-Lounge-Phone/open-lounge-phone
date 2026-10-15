/**
 * Which microphone and speaker calls use, and how loud the other person is: chosen on the call
 * screen and remembered on this device (browser storage), never sent anywhere.
 */

export interface AudioPrefs {
  /** `deviceId` of the microphone (undefined = the system's default). */
  input?: string;
  /** `deviceId` of the speaker or headphones (undefined = the system's default). */
  output?: string;
  /** The other person's volume, 0–1. */
  volume: number;
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = { volume: 1 };
const KEY = "olp.audio";

/** The part of `localStorage` used here (so tests can pass a plain object). */
export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadAudioPrefs(store: PrefStore | undefined): AudioPrefs {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return DEFAULT_AUDIO_PREFS;
    const v = JSON.parse(raw) as Partial<AudioPrefs>;
    const volume =
      typeof v.volume === "number" && Number.isFinite(v.volume)
        ? Math.min(1, Math.max(0, v.volume))
        : 1;
    return {
      ...(typeof v.input === "string" && v.input ? { input: v.input } : {}),
      ...(typeof v.output === "string" && v.output ? { output: v.output } : {}),
      volume,
    };
  } catch {
    return DEFAULT_AUDIO_PREFS;
  }
}

export function saveAudioPrefs(store: PrefStore | undefined, prefs: AudioPrefs): void {
  try {
    store?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage blocked (a private window): the choice lasts for this page only.
  }
}

export interface AudioDevice {
  id: string;
  label: string;
}

/**
 * The microphones and speakers to offer, from `enumerateDevices()`: real devices only (the
 * browser's "default" and "communications" aliases are the "System default" choice), each
 * with a label (devices without one are numbered: the browser hides names until the microphone
 * is allowed).
 */
export function audioDevices(
  list: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[],
): {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
} {
  const pick = (kind: MediaDeviceKind, word: string) =>
    list
      .filter(
        (d) => d.kind === kind && d.deviceId && !/^(default|communications)$/.test(d.deviceId),
      )
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  return { inputs: pick("audioinput", "Microphone"), outputs: pick("audiooutput", "Speaker") };
}

/** A remembered device that is still there, else undefined (the system default). */
export function stillThere(
  id: string | undefined,
  devices: readonly AudioDevice[],
): string | undefined {
  return id && devices.some((d) => d.id === id) ? id : undefined;
}

/** Whether this browser can send call audio to a chosen speaker (`HTMLMediaElement.setSinkId`). */
export function canChooseSpeaker(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}
