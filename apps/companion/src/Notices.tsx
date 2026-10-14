// Notices (docs/notices.md): post a short message to the space's phones ("Bus is here"), with
// an optional recording; take one down. Guardians (owner and admins in a team) only.
import { NOTICE_LINE_CHARS, noticeLines } from "@openloungephone/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, DeviceSummary, NoticeView } from "./api.ts";
import { VoicemailRecorder } from "./recording.ts";

const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: "15 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 180, label: "3 hours" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "a day" },
];

export function Notices({ api, devices }: { api: Api; devices: DeviceSummary[] }) {
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [some, setSome] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [audio, setAudio] = useState<{ blob: Blob; durationMs: number }>();
  const [recording, setRecording] = useState(false);
  const [list, setList] = useState<NoticeView[]>([]);
  const [error, setError] = useState<string>();
  const recorder = useRef<VoicemailRecorder>(undefined);

  const load = useCallback(
    () => api.notices().then(setList, (e: Error) => setError(e.message)),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => recorder.current?.cancel(), []);

  const parsed = text.trim() ? noticeLines(text) : undefined;
  const problem = parsed && "error" in parsed ? parsed.error : undefined;

  const record = async () => {
    setRecording(true);
    const r = new VoicemailRecorder(
      {
        onTick: () => {},
        onDone: (rec) => {
          setRecording(false);
          setAudio({ blob: rec.blob, durationMs: rec.durationMs });
        },
        onError: (message) => {
          setRecording(false);
          setError(message);
        },
      },
      30_000,
    );
    recorder.current = r;
    await r.start();
  };

  const post = async () => {
    setError(undefined);
    try {
      const n = await api.postNotice({
        text,
        minutes,
        ...(some && picked.length ? { deviceIds: picked } : {}),
      });
      if (audio) await api.setNoticeAudio(n.id, audio.blob, audio.durationMs);
      setText("");
      setAudio(undefined);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const live = list.filter((n) => n.live);
  return (
    <section className="card stack notices">
      <h3>Notice to the phones</h3>
      <p className="hint">
        A short message every phone shows with a chime, like "Bus is here". Lifting the handset
        plays your recording, and a key clears it.
      </p>
      <label className="stack">
        <span className="muted small">Up to two lines of {NOTICE_LINE_CHARS} characters</span>
        <textarea
          aria-label="Notice"
          rows={2}
          value={text}
          placeholder={"Dinner's ready"}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {problem && <span className="error small">{problem}</span>}
      <label className="row">
        <span>For</span>
        <select
          aria-label="How long"
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        >
          {DURATIONS.map((d) => (
            <option key={d.minutes} value={d.minutes}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={some} onChange={(e) => setSome(e.target.checked)} />
        <span>Only some phones</span>
      </label>
      {some && (
        <div className="row wrap">
          {devices.map((d) => (
            <label key={d.id} className="check small">
              <input
                type="checkbox"
                checked={picked.includes(d.id)}
                onChange={(e) =>
                  setPicked((p) => (e.target.checked ? [...p, d.id] : p.filter((x) => x !== d.id)))
                }
              />
              <span>{d.name}</span>
            </label>
          ))}
        </div>
      )}
      <div className="row">
        {recording ? (
          <button type="button" className="primary" onClick={() => recorder.current?.stop()}>
            Stop recording
          </button>
        ) : (
          <button type="button" onClick={() => void record()}>
            {audio ? "Record again" : "Record a message (30 s)"}
          </button>
        )}
        {audio && !recording && (
          <>
            <span className="muted small">{Math.round(audio.durationMs / 1000)} s recorded</span>
            <button type="button" className="link" onClick={() => setAudio(undefined)}>
              Remove
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        className="primary"
        disabled={!parsed || !!problem || recording || (some && !picked.length)}
        onClick={() => void post()}
      >
        Send to the phones
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {live.length > 0 && (
        <ul className="stack">
          {live.map((n) => (
            <li key={n.id} className="row small">
              <span className="grow">
                {n.lines.join(" / ")}{" "}
                <span className="muted">
                  · {n.from} · until {new Date(n.expiresAt).toLocaleTimeString()}
                  {n.audio ? " · recorded" : ""}
                </span>
              </span>
              <button
                type="button"
                className="link"
                onClick={() => void api.deleteNotice(n.id).then(load)}
              >
                Take down
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
