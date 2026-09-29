import { useCallback, useEffect, useState } from "react";
import type { Api, RecordingInfo, SpacePrivacyInfo } from "./api.ts";
import { RETENTION_LABEL } from "./timelineText.ts";

type Choice = SpacePrivacyInfo["history"];
const CHOICES: Choice[] = ["30d", "1y", "forever"];

/**
 * This space's privacy settings: how long its history and voicemail are kept by default, and
 * whether voicemail is transcribed. Everyone sees them; guardians change them.
 */
export function SpacePrivacy({ api, guardian }: { api: Api; guardian: boolean }) {
  const [info, setInfo] = useState<SpacePrivacyInfo>();
  const [rec, setRec] = useState<RecordingInfo>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.spacePrivacy().then(setInfo, (e: Error) => setError(e.message));
    api.recordingSetting().then(setRec, () => {});
  }, [api]);
  useEffect(load, [load]);
  const save = (patch: Parameters<Api["setSpacePrivacy"]>[0]) =>
    api.setSpacePrivacy(patch).then(load, (e: Error) => setError(e.message));
  if (!info) return null;
  const select = (label: string, value: Choice, key: "history" | "voicemail") => (
    <label>
      {label}
      <select
        value={value}
        disabled={!guardian}
        onChange={(e) => void save({ [key]: e.target.value as Choice })}
      >
        {CHOICES.map((c) => (
          <option key={c} value={c}>
            {c === "forever" ? "Forever" : RETENTION_LABEL[c]}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="card stack">
      <h3>Privacy in this space</h3>
      {select("Keep call history and Lounge sign-ins for", info.history, "history")}
      {select("Keep voicemail for", info.voicemail, "voicemail")}
      <span className="hint">
        Older ones are deleted, audio included. A person's own setting for their buddies comes
        first.
      </span>
      <label className="check">
        <input
          type="checkbox"
          checked={info.transcription}
          disabled={!guardian || !info.transcriber}
          onChange={(e) => void save({ transcription: e.target.checked })}
        />
        <span>
          Transcribe voicemail
          <span className="hint">
            {info.transcriber
              ? " — off: messages are never sent to speech-to-text."
              : " — this server has no speech-to-text."}
          </span>
        </span>
      </label>
      {rec && (
        <label className="check">
          <input
            type="checkbox"
            checked={rec.enabled}
            disabled={!guardian || (!rec.allowed && !rec.enabled)}
            onChange={(e) =>
              void api
                .setRecording(e.target.checked)
                .then(load, (err: Error) => setError(err.message))
            }
          />
          <span>
            Record calls
            <span className="hint">
              {rec.allowed
                ? ' — off by default. Every call and room is announced ("This call is recorded"), with a mark in the apps and the recording light on phones; recordings follow the history setting above. Never with a kids\' phone.'
                : ` — ${rec.reason ?? "not allowed here"}.`}
            </span>
          </span>
        </label>
      )}
      {!guardian && <span className="hint">Guardians can change these.</span>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
