import { describe, expect, it } from "vitest";
import {
  audioDevices,
  DEFAULT_AUDIO_PREFS,
  loadAudioPrefs,
  saveAudioPrefs,
  stillThere,
} from "./audioPrefs.ts";

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
};

describe("audio choices", () => {
  it("are remembered on this device", () => {
    const store = memory();
    expect(loadAudioPrefs(store)).toEqual(DEFAULT_AUDIO_PREFS);
    saveAudioPrefs(store, { input: "mic2", output: "spk1", volume: 0.4 });
    expect(loadAudioPrefs(store)).toEqual({ input: "mic2", output: "spk1", volume: 0.4 });
    // Broken or odd values fall back to the defaults.
    store.setItem("olp.audio", "{not json");
    expect(loadAudioPrefs(store)).toEqual(DEFAULT_AUDIO_PREFS);
    store.setItem("olp.audio", JSON.stringify({ input: 3, volume: 7 }));
    expect(loadAudioPrefs(store)).toEqual({ volume: 1 });
    expect(loadAudioPrefs(undefined)).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it("lists real devices, named, and forgets one that's gone", () => {
    const { inputs, outputs } = audioDevices([
      { deviceId: "default", kind: "audioinput", label: "Default - USB mic" },
      { deviceId: "a1", kind: "audioinput", label: "USB mic" },
      { deviceId: "a2", kind: "audioinput", label: "" },
      { deviceId: "communications", kind: "audiooutput", label: "Communications" },
      { deviceId: "o1", kind: "audiooutput", label: "Headphones" },
      { deviceId: "v1", kind: "videoinput", label: "Camera" },
    ]);
    expect(inputs).toEqual([
      { id: "a1", label: "USB mic" },
      { id: "a2", label: "Microphone 2" },
    ]);
    expect(outputs).toEqual([{ id: "o1", label: "Headphones" }]);
    expect(stillThere("a2", inputs)).toBe("a2");
    expect(stillThere("gone", inputs)).toBeUndefined();
    expect(stillThere(undefined, inputs)).toBeUndefined();
  });
});
