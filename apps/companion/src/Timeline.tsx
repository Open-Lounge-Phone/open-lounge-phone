import { useCallback, useEffect, useState } from "react";
import type { Api, Retention, Timeline } from "./api.ts";
import { formatDuration, formatWhen, transcriptText } from "./text.ts";
import { callLine, inheritedRetention, retentionOptions } from "./timelineText.ts";
import { Player } from "./Voicemail.tsx";

interface Props {
  api: Api;
  connectionId: string;
  refreshKey: number;
  onBack(): void;
  onCall?: (() => void) | undefined;
}

/**
 * One buddy's history: calls both ways (when, how long, answered or missed) and the voicemails
 * they left you, with transcripts. There's no text chat. History expires as this connection (or
 * your account default) says.
 */
export function BuddyTimeline({ api, connectionId, refreshKey, onBack, onCall }: Props) {
  const [data, setData] = useState<Timeline>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      setData(await api.timeline(connectionId));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, connectionId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the refetch trigger
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const setRetention = async (retention: Retention) => {
    setError(undefined);
    try {
      await api.setConnectionRetention(connectionId, retention);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const now = Date.now();
  const c = data?.connection;
  return (
    <section className="stack timeline">
      <button type="button" className="link back" onClick={onBack}>
        ← Connections
      </button>
      <div className="person">
        <div>
          <h2>{c?.name ?? "…"}</h2>
          {c && <div className="muted small">{c.address}</div>}
        </div>
        {onCall && c?.state === "active" && (
          <button type="button" className="primary" onClick={onCall}>
            Call
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {data && (
        <label className="card stack">
          <span>Keep our history</span>
          <select
            value={data.retention.setting}
            onChange={(e) => void setRetention(e.target.value as Retention)}
          >
            {retentionOptions(
              inheritedRetention(
                data.retention.account,
                data.retention.from === "space" ? data.retention.effective : "forever",
              ),
              "Account default",
            ).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="hint">
            Calls and voicemails with {c?.name} older than this are deleted, audio included. Only
            your side: they keep their own history.
          </span>
        </label>
      )}
      {data?.items.length === 0 && (
        <div className="card empty">
          <p className="muted">No calls yet.</p>
        </div>
      )}
      <ol className="stack timeline-items">
        {data?.items.map((item) => {
          const vm = item.voicemail;
          return (
            <li key={`${item.kind}:${item.id}`} className="card stack">
              <div className="vm-head">
                <div>
                  <div className="device-name">
                    {item.kind === "call" ? callLine(item) : "Voicemail"}
                  </div>
                  <div className="muted small">{formatWhen(item.at, now)}</div>
                </div>
              </div>
              {item.kind === "call" && item.recording && (
                <div className="stack">
                  <div className="small">
                    <span className="badge">Recorded</span>{" "}
                    {formatDuration(item.recording.durationMs)}
                  </div>
                  {item.recording.transcriptStatus !== "unavailable" && (
                    <p className={`transcript ${item.recording.transcriptStatus}`}>
                      {transcriptText(item.recording.transcriptStatus, item.recording.transcript)}
                    </p>
                  )}
                  <Player
                    api={api}
                    voicemail={item.recording}
                    fetchAudio={api.recordingAudio}
                    onFinished={() => {}}
                  />
                </div>
              )}
              {vm && (
                <div className={`stack voicemail ${vm.heardAt ? "" : "unheard"}`}>
                  <div className="small">
                    {!vm.heardAt && <span className="badge">New</span>} Voicemail ·{" "}
                    {formatDuration(vm.durationMs)}
                  </div>
                  <p className={`transcript ${vm.transcriptStatus}`}>
                    {transcriptText(vm.transcriptStatus, vm.transcript)}
                  </p>
                  <Player
                    api={api}
                    voicemail={vm}
                    onFinished={() => {
                      if (!vm.heardAt) void api.markHeard(vm.id).then(load);
                    }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
