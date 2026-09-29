import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, DeviceSummary, VoicemailSummary } from "./api.ts";
import { GreetingEditor } from "./GreetingEditor.tsx";
import { formatDuration, formatWhen, transcriptText } from "./text.ts";

const POLL_MS = 5000;

interface Props {
  api: Api;
  devices: DeviceSummary[];
  /** Changes whenever a `voicemail.new` arrives, to refetch. */
  refreshKey: number;
  onChanged(): void;
  onBack(): void;
}

export function VoicemailInbox({ api, devices, refreshKey, onChanged, onBack }: Props) {
  const [items, setItems] = useState<VoicemailSummary[]>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setItems(await api.voicemails());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the refetch trigger
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Poll while transcripts are still being produced.
  const pending = items?.some((v) => v.transcriptStatus === "pending") ?? false;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? "a phone";

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
    onChanged();
  };

  const now = Date.now();

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Voicemail</h2>
      <GreetingEditor api={api} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {items?.length === 0 && (
        <div className="card empty">
          <p>No messages.</p>
          <p className="muted">
            When a call isn't answered — you're busy, away or not taking calls, or it's quiet hours
            for a phone — the caller can leave a message here.
          </p>
        </div>
      )}
      <ul className="stack">
        {items?.map((v) => (
          <li key={v.id} className={`card voicemail ${v.heardAt ? "" : "unheard"}`}>
            <div className="vm-head">
              <div>
                <div className="device-name">
                  {!v.heardAt && <span className="badge">New</span>} {v.fromLabel}
                </div>
                <div className="muted small">
                  {v.deviceId ? `for ${deviceName(v.deviceId)}` : "for you"} ·{" "}
                  {formatWhen(v.createdAt, now)} · {formatDuration(v.durationMs)}
                </div>
              </div>
            </div>
            <p className={`transcript ${v.transcriptStatus}`}>
              {transcriptText(v.transcriptStatus, v.transcript)}
            </p>
            <Player
              api={api}
              voicemail={v}
              onFinished={() => {
                if (!v.heardAt) void act(() => api.markHeard(v.id));
              }}
            />
            <div className="row">
              {!v.heardAt && (
                <button type="button" onClick={() => void act(() => api.markHeard(v.id))}>
                  Mark heard
                </button>
              )}
              <button
                type="button"
                className="danger"
                onClick={() => void act(() => api.deleteVoicemail(v.id))}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Audio needs a bearer token, so it's fetched into an object URL on demand. */
export function Player({
  api,
  voicemail,
  onFinished,
}: {
  api: Api;
  voicemail: Pick<VoicemailSummary, "id">;
  onFinished(): void;
}) {
  const [url, setUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const urlRef = useRef<string>(undefined);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const blob = await api.voicemailAudio(voicemail.id);
      const u = URL.createObjectURL(blob);
      urlRef.current = u;
      setUrl(u);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  if (url) {
    // biome-ignore lint/a11y/useMediaCaption: the transcript is shown above
    return <audio controls autoPlay src={url} onEnded={onFinished} className="vm-audio" />;
  }
  return (
    <>
      <button type="button" className="primary" disabled={loading} onClick={() => void load()}>
        {loading ? "Loading…" : "▶ Play"}
      </button>
      {error && <p className="error">{error}</p>}
    </>
  );
}
