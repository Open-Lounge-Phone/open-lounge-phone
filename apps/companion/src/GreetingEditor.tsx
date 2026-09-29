import { greetingScript } from "@openloungephone/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, GreetingKind, VoicemailSettings } from "./api.ts";
import { type Recording, VoicemailRecorder } from "./recording.ts";
import { formatDuration } from "./text.ts";

/** Longest recording per kind, as the server enforces it. */
const MAX_MS = { name: 3_000, custom: 30_000 } as const;
const RING_CHOICES = [10, 15, 20, 25, 30, 40, 50, 60];

type Draft =
  | { stage: "recording"; kind: "name" | "custom"; elapsed: number }
  | { stage: "review"; kind: "name" | "custom"; recording: Recording; url: string }
  | { stage: "saving"; kind: "name" | "custom"; recording: Recording; url: string };

const KIND_TEXT: Record<GreetingKind, string> = {
  default: "Standard greeting",
  name: "Standard greeting with your name",
  custom: "Your own greeting",
};

function standardSentence(name: string): string {
  return greetingScript("default", name)
    .map((s) => (s.kind === "say" ? s.text : ""))
    .join(" ")
    .trim();
}

/**
 * What callers hear when a call goes to voicemail, and how long calls ring first: yours, or (with
 * `deviceId`, for guardians) a kids' phone's. Record, play back, re-record, or go back to the
 * standard greeting.
 */
export function GreetingEditor({ api, deviceId }: { api: Api; deviceId?: string }) {
  const [settings, setSettings] = useState<VoicemailSettings>();
  const [draft, setDraft] = useState<Draft>();
  const [playing, setPlaying] = useState<string>();
  const [error, setError] = useState<string>();
  const recorder = useRef<VoicemailRecorder>(undefined);
  const urls = useRef<string[]>([]);
  const whose = deviceId ? "this phone's" : "your";

  const load = useCallback(async () => {
    try {
      setSettings(await api.voicemailSettings(deviceId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      recorder.current?.cancel();
      for (const u of urls.current) URL.revokeObjectURL(u);
      if ("speechSynthesis" in window) speechSynthesis.cancel();
    },
    [],
  );

  const keepUrl = (blob: Blob) => {
    const u = URL.createObjectURL(blob);
    urls.current.push(u);
    return u;
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const record = async (kind: "name" | "custom") => {
    setError(undefined);
    setPlaying(undefined);
    setDraft({ stage: "recording", kind, elapsed: 0 });
    const r = new VoicemailRecorder(
      {
        onTick: (elapsed) => setDraft({ stage: "recording", kind, elapsed }),
        onDone: (recording) =>
          setDraft({ stage: "review", kind, recording, url: keepUrl(recording.blob) }),
        onError: (message) => {
          setDraft(undefined);
          setError(message);
        },
      },
      MAX_MS[kind],
    );
    recorder.current = r;
    await r.start();
  };

  const save = async (d: Extract<Draft, { stage: "review" }>) => {
    setDraft({ ...d, stage: "saving" });
    await act(() => api.setGreeting(d.kind, d.recording.blob, d.recording.durationMs, deviceId));
    setDraft(undefined);
  };

  const playCurrent = async () => {
    if (!settings) return;
    setError(undefined);
    if (settings.greeting.kind === "default") {
      if ("speechSynthesis" in window) {
        speechSynthesis.cancel();
        speechSynthesis.speak(new SpeechSynthesisUtterance(standardSentence(settings.name)));
      }
      return;
    }
    try {
      const blob = await api.greetingAudio(deviceId);
      if (blob) setPlaying(keepUrl(blob));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!settings) {
    return error ? <p className="error">{error}</p> : null;
  }
  const kind = settings.greeting.kind;

  return (
    <details className="card stack greeting-editor">
      <summary>
        Greeting: <strong>{KIND_TEXT[kind]}</strong> · rings {settings.ringSeconds} s
      </summary>
      <p className="muted small">
        When {deviceId ? "this phone" : "you"} can't answer — no answer in time, declined, busy,
        away or quiet hours — callers hear {whose} greeting and can leave a message of up to two
        minutes.
      </p>

      <div className="stack">
        <p>
          Now: <strong>{KIND_TEXT[kind]}</strong>
          {kind === "default" && (
            <span className="muted"> — “{standardSentence(settings.name)}”</span>
          )}
          {kind === "name" && (
            <span className="muted">
              {" "}
              — “(your recording) can't take your call. Leave a message after the tone.”
            </span>
          )}
        </p>
        <div className="row">
          <button type="button" onClick={() => void playCurrent()}>
            ▶ Play
          </button>
          {kind !== "default" && (
            <button type="button" onClick={() => void act(() => api.resetGreeting(deviceId))}>
              Use the standard greeting
            </button>
          )}
        </div>
        {/* biome-ignore lint/a11y/useMediaCaption: the greeting's owner's own recording */}
        {playing && <audio controls autoPlay src={playing} />}
      </div>

      {!draft && (
        <div className="row">
          <button type="button" onClick={() => void record("name")}>
            Record just {deviceId ? "the name" : "your name"} (3 s)
          </button>
          <button type="button" onClick={() => void record("custom")}>
            Record a whole greeting (30 s)
          </button>
        </div>
      )}
      {draft?.stage === "recording" && (
        <div className="stack">
          <p className="recording" aria-live="polite">
            <span className="rec-dot" aria-hidden />{" "}
            {draft.kind === "name" ? "Say the name now" : "Say your greeting now"} ·{" "}
            {formatDuration(MAX_MS[draft.kind] - draft.elapsed)} left
          </p>
          <progress max={MAX_MS[draft.kind]} value={draft.elapsed} />
          <div className="row">
            <button type="button" className="primary" onClick={() => recorder.current?.stop()}>
              Stop
            </button>
          </div>
        </div>
      )}
      {(draft?.stage === "review" || draft?.stage === "saving") && (
        <div className="stack">
          <p>
            {draft.kind === "name" ? "Your name" : "Your greeting"} (
            {formatDuration(draft.recording.durationMs)}):
          </p>
          {/* biome-ignore lint/a11y/useMediaCaption: the greeting's owner's own recording */}
          <audio controls src={draft.url} />
          <div className="row">
            <button
              type="button"
              disabled={draft.stage === "saving"}
              onClick={() => void record(draft.kind)}
            >
              Re-record
            </button>
            <button
              type="button"
              className="primary"
              disabled={draft.stage === "saving"}
              onClick={() => draft.stage === "review" && void save(draft)}
            >
              {draft.stage === "saving" ? "Saving…" : "Save"}
            </button>
            <button type="button" className="link" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <label>
        How long calls ring before voicemail
        <select
          value={settings.ringSeconds}
          onChange={(e) =>
            void act(() =>
              api.setVoicemailSettings({ ringSeconds: Number(e.target.value) }, deviceId),
            )
          }
        >
          {RING_CHOICES.map((s) => (
            <option key={s} value={s}>
              {s} seconds
            </option>
          ))}
        </select>
      </label>
      {deviceId && (
        <label className="check">
          <input
            type="checkbox"
            checked={settings.childGreeting ?? true}
            onChange={(e) =>
              void act(() =>
                api.setVoicemailSettings({ childGreeting: e.target.checked }, deviceId),
              )
            }
          />
          Let the child record the greeting on the phone (MENU → Voicemail)
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
