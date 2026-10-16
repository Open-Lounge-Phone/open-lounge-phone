import { useCallback, useEffect, useState } from "react";
import type { Api, RecordingSummary } from "./api.ts";
import { formatDuration, formatWhen, transcriptText } from "./text.ts";
import { Player } from "./Voicemail.tsx";

/**
 * Recordings of calls and rooms you were in (guardians and admins: all of this space's), with
 * Delete where you may (whoever made it, or the space's guardians). Shown only when there are
 * some: recording is off unless a space turns it on.
 */
export function Recordings({ api, refreshKey }: { api: Api; refreshKey?: number }) {
  const [items, setItems] = useState<RecordingSummary[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.recordings().then(
      (r) => {
        setItems(r);
        setError(undefined);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the refetch trigger
  useEffect(load, [load, refreshKey]);
  if (!items?.length && !error) return null;
  const now = Date.now();
  const remove = (r: RecordingSummary) => {
    if (!window.confirm(`Delete the recording with ${r.peerLabel}? Nobody can hear it after.`)) {
      return;
    }
    api.deleteRecording(r.id).then(load, (e: Error) => setError(e.message));
  };
  return (
    <section className="stack recordings" aria-labelledby="recordings-title">
      <h3 id="recordings-title">Call recordings</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul className="stack">
        {items?.map((r) => (
          <li key={r.id} className="card stack">
            <div>
              <div className="device-name">
                {r.kind === "room" ? `Room: ${r.peerLabel}` : r.peerLabel}
              </div>
              <div className="muted small">
                {formatWhen(r.startedAt, now)} · {formatDuration(r.durationMs)}
              </div>
            </div>
            {r.transcriptStatus !== "unavailable" && (
              <p className={`transcript ${r.transcriptStatus}`}>
                {transcriptText(r.transcriptStatus, r.transcript)}
              </p>
            )}
            <div className="row">
              <Player
                api={api}
                voicemail={r}
                fetchAudio={api.recordingAudio}
                onFinished={() => {}}
              />
              {r.canDelete && (
                <button type="button" className="danger" onClick={() => remove(r)}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
