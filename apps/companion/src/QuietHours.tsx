import { useEffect, useState } from "react";
import type { Api, QuietRule } from "./api.ts";
import { DAY_LABELS, describeRule, spansMidnight, toggleDay, validateRule } from "./quiet.ts";

const SCHOOL_NIGHT: QuietRule = { days: [0, 1, 2, 3, 4], start: "20:30", end: "07:00" };

export function QuietHours({ api, onBack }: { api: Api; onBack(): void }) {
  const [rules, setRules] = useState<QuietRule[]>([]);
  const [timeZone, setTimeZone] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api.quietHours().then(
      (s) => {
        setRules(s.rules);
        setTimeZone(s.timeZone);
        setLoaded(true);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);

  const update = (i: number, patch: Partial<QuietRule>) => {
    setStatus(undefined);
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const problems = rules.map(validateRule);
  const valid = problems.every((p) => p === undefined);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await api.setQuietHours(rules);
      setStatus("Saved. Phones update right away.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>Quiet hours</h2>
      <p className="muted small">
        During quiet hours phones don't ring (callers will get voicemail) and can't call out, except
        for people marked "rings during quiet hours". Times are in {timeZone || "your"} time.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loaded && rules.length === 0 && <p className="card empty">No quiet hours set.</p>}
      <ul className="stack">
        {rules.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids until saved
          <li key={i} className="card stack">
            <fieldset className="days">
              <legend className="sr-only">Days</legend>
              {DAY_LABELS.map((label, d) => (
                <label key={label} className={`day ${r.days.includes(d) ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={r.days.includes(d)}
                    onChange={() => update(i, { days: toggleDay(r.days, d) })}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <label>
                From
                <input
                  type="time"
                  value={r.start}
                  onChange={(e) => update(i, { start: e.target.value })}
                  required
                />
              </label>
              <label>
                Until
                <input
                  type="time"
                  value={r.end}
                  onChange={(e) => update(i, { end: e.target.value })}
                  required
                />
              </label>
            </div>
            <p className="small muted">
              {problems[i] ?? describeRule(r)}
              {!problems[i] && spansMidnight(r) && r.start !== r.end && " — runs past midnight"}
            </p>
            <button
              type="button"
              className="link danger"
              onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" onClick={() => setRules((rs) => [...rs, { ...SCHOOL_NIGHT }])}>
          + Add quiet time
        </button>
        <button
          type="button"
          className="primary"
          disabled={!loaded || !valid || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {status && <p className="ok">{status}</p>}
    </section>
  );
}
