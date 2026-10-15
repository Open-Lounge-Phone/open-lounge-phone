import { useCallback, useEffect, useState } from "react";
import type { Api, CallBackHint, MissedCall } from "./api.ts";
import { missedSummary } from "./text.ts";

interface Props {
  api: Api;
  /** Bumped when the server says they changed (a new one, or cleared elsewhere). */
  seq?: number;
  onCallBack(hint: CallBackHint, label: string): void;
}

/**
 * Your missed calls (rang, nobody answered, no message) from every space, and public lines'
 * call backs you didn't take. Clearing them clears them on your phones too.
 */
export function MissedCalls({ api, seq, onCallBack }: Props) {
  const [list, setList] = useState<MissedCall[]>([]);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setList(await api.missed());
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seq reloads them
  useEffect(() => {
    void load();
  }, [load, seq]);
  if (!list.length && !error) return null;
  const now = Date.now();
  return (
    <section className="card stack missed-calls" aria-labelledby="missed-title">
      <div className="missed-row">
        <h3 id="missed-title">Missed calls</h3>
        {list.length > 0 && (
          <button
            type="button"
            className="link"
            onClick={() => void api.clearMissed().then(load, (e) => setError(e.message))}
          >
            Clear all
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="stack">
        {list.map((m) => (
          <li key={m.id} className="missed-row">
            <div>
              <div>{m.from}</div>
              <div className="muted small">{missedSummary(m, now)}</div>
            </div>
            {m.callBack ? (
              <button type="button" onClick={() => onCallBack(m.callBack as CallBackHint, m.from)}>
                Call back
              </button>
            ) : (
              <span className="muted small">Call back from {m.space ?? "the app"}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
