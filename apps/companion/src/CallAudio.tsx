import {
  type AudioDevice,
  type AudioPrefs,
  audioDevices,
  canChooseSpeaker,
  loadAudioPrefs,
  MicLevel,
  meterFill,
  type SilenceState,
  saveAudioPrefs,
  silenceStep,
  stillThere,
} from "@openloungephone/client";
import { type RefObject, useEffect, useState } from "react";
import type { Connection } from "./connection.ts";

/** Browser storage, if this page may use it. */
function store(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

/** The words when the microphone sends nothing while you're not muted. */
export const MIC_SILENT_TEXT = "Your microphone is silent: check it isn't muted or blocked.";

/**
 * The microphone's live level, and a plain warning when it sends nothing for a few seconds while
 * you're not muted.
 */
export function MicMeter({
  conn,
  muted,
  micSeq,
}: {
  conn: Connection;
  muted: boolean;
  micSeq?: number;
}) {
  const [fill, setFill] = useState(0);
  const [silent, setSilent] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: micSeq re-reads a new microphone
  useEffect(() => {
    const stream = conn.micStream();
    if (!stream || typeof AudioContext === "undefined") return;
    let meter: MicLevel;
    try {
      meter = new MicLevel(stream);
    } catch {
      return;
    }
    let s: SilenceState = {};
    const t = setInterval(() => {
      const level = meter.read();
      const r = silenceStep(s, { level, muted, now: Date.now() });
      s = r.state;
      setFill(meterFill(level));
      setSilent(r.silent);
    }, 100);
    return () => {
      clearInterval(t);
      meter.close();
    };
  }, [conn, muted, micSeq]);
  return (
    <div className="mic-check">
      <meter
        className="mic-meter"
        aria-label="Microphone level"
        min={0}
        max={100}
        value={Math.round(fill * 100)}
      />
      {silent && (
        <div className="mic-silent" role="alert">
          {MIC_SILENT_TEXT}
        </div>
      )}
    </div>
  );
}

/**
 * Microphone, speaker and the other person's volume for calls; remembered on this device. The
 * speaker choice shows only where the browser can send audio to a chosen device.
 */
export function AudioChoices({
  conn,
  audio,
}: {
  conn: Connection;
  audio: RefObject<HTMLAudioElement | null>;
}) {
  const [prefs, setPrefs] = useState<AudioPrefs>(() => loadAudioPrefs(store()));
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const speaker = canChooseSpeaker();

  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    const load = () =>
      void md.enumerateDevices().then((list) => {
        const d = audioDevices(list);
        setInputs(d.inputs);
        setOutputs(d.outputs);
      });
    load();
    md.addEventListener?.("devicechange", load);
    return () => md.removeEventListener?.("devicechange", load);
  }, []);

  const update = (next: AudioPrefs) => {
    setPrefs(next);
    saveAudioPrefs(store(), next);
  };
  const input = stillThere(prefs.input, inputs);
  const output = stillThere(prefs.output, outputs);

  return (
    <div className="audio-choices stack">
      <label className="row">
        <span>Microphone</span>
        <select
          value={input ?? ""}
          onChange={(e) => {
            const id = e.target.value || undefined;
            void conn.setInput(id).then((ok) => {
              if (ok) update({ ...prefs, ...(id ? { input: id } : { input: undefined }) });
            });
          }}
        >
          <option value="">System default</option>
          {inputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      {speaker && (
        <label className="row">
          <span>Speaker</span>
          <select
            value={output ?? ""}
            onChange={(e) => {
              const id = e.target.value || undefined;
              void applySpeaker(audio.current, id);
              update({ ...prefs, output: id });
            }}
          >
            <option value="">System default</option>
            {outputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="row">
        <span>Their volume</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(prefs.volume * 100)}
          onChange={(e) => {
            const volume = Number(e.target.value) / 100;
            if (audio.current) audio.current.volume = volume;
            update({ ...prefs, volume });
          }}
        />
      </label>
    </div>
  );
}

/** Sends the call's audio to the chosen speaker (where the browser can). */
export async function applySpeaker(el: HTMLAudioElement | null, id: string | undefined) {
  if (!el || !canChooseSpeaker()) return;
  try {
    await (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(id ?? "");
  } catch {
    // The device went away: the system default plays it.
  }
}

/** The remembered speaker and volume, applied to the call's audio element. */
export function useCallAudioPrefs(audio: RefObject<HTMLAudioElement | null>) {
  useEffect(() => {
    const prefs = loadAudioPrefs(store());
    if (audio.current) audio.current.volume = prefs.volume;
    if (prefs.output) void applySpeaker(audio.current, prefs.output);
  }, [audio]);
}
