import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, QuietRule } from "./api.ts";
import {
  DAY_LABELS,
  DAY_SHORTCUTS,
  friendlyRule,
  PRESETS,
  spansMidnight,
  toggleDay,
  validateRule,
  weekSegments,
} from "./quiet.ts";
import { quietStatus } from "./quietStatus.ts";

const AUTOSAVE_MS = 600;

type SaveState = "idle" | "saving" | "saved" | "error";

interface Props {
  api: Api;
  onBack(): void;
  /** Opens the phones list, where "rings during quiet hours" is set per person. */
  onPhones(): void;
}

export function QuietHours({ api, onBack, onPhones }: Props) {
  const [rules, setRules] = useState<QuietRule[]>([]);
  const [timeZone, setTimeZone] = useState("UTC");
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<number>();
  const [adding, setAdding] = useState(false);
  const [save, setSave] = useState<SaveState>("idle");
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());
  const dirty = useRef(false);

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

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const persist = useCallback(
    async (next: QuietRule[]) => {
      setSave("saving");
      try {
        await api.setQuietHours(next);
        setSave("saved");
        setNow(new Date());
      } catch (e) {
        setError((e as Error).message);
        setSave("error");
      }
    },
    [api],
  );

  // Autosave shortly after the last edit, once every rule is valid.
  const valid = rules.every((r) => validateRule(r) === undefined);
  useEffect(() => {
    if (!loaded || !dirty.current || !valid) return;
    const t = setTimeout(() => {
      dirty.current = false;
      void persist(rules);
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [rules, loaded, valid, persist]);

  const change = (next: QuietRule[]) => {
    dirty.current = true;
    setError(undefined);
    setSave("idle");
    setRules(next);
  };
  const update = (i: number, patch: Partial<QuietRule>) =>
    change(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    change(rules.filter((_, j) => j !== i));
    setEditing(undefined);
  };
  const add = (rule: QuietRule) => {
    change([...rules, { ...rule, days: [...rule.days] }]);
    setEditing(rules.length);
    setAdding(false);
  };

  const status = loaded ? quietStatus({ timeZone, rules }, now) : undefined;
  const week = weekSegments(rules);

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <div className="title-row">
        <h2>Quiet hours</h2>
        <SaveStatus state={save} onRetry={() => void persist(rules)} />
      </div>

      {status && (
        <p className={`quiet-status ${status.quiet ? "is-quiet" : ""}`} role="status">
          <span aria-hidden="true">{status.quiet ? "🌙" : "☀️"}</span> {status.text}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <p className="muted small">
        During quiet hours phones don't ring — callers can leave a voicemail instead — and phones
        can't call out. People marked <em>"rings during quiet hours"</em> on a phone still get
        through;{" "}
        <button type="button" className="link inline" onClick={onPhones}>
          set that per phone
        </button>
        . Times are in {timeZone.replace(/_/g, " ")} time.
      </p>

      {loaded && rules.length === 0 && !adding && (
        <p className="card empty">No quiet hours yet — phones can ring any time.</p>
      )}

      <ul className="stack">
        {rules.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no ids
          <li key={i} className="card stack rule">
            {editing === i ? (
              <RuleEditor
                rule={r}
                onChange={(patch) => update(i, patch)}
                onDone={() => setEditing(undefined)}
                onRemove={() => remove(i)}
              />
            ) : (
              <div className="rule-summary">
                <span className="rule-text">
                  {validateRule(r) ? `${validateRule(r)} — tap Edit` : friendlyRule(r)}
                </span>
                <span className="rule-actions">
                  <button type="button" onClick={() => setEditing(i)}>
                    Edit
                  </button>
                  <button type="button" className="danger" onClick={() => remove(i)}>
                    Remove
                  </button>
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="card stack">
          <h3>Add quiet time</h3>
          <div className="presets">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" onClick={() => add(p.rule)}>
                {p.label}
              </button>
            ))}
          </div>
          <button type="button" className="link" onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="add" disabled={!loaded} onClick={() => setAdding(true)}>
          + Add quiet time
        </button>
      )}

      {rules.length > 0 && <WeekChart week={week} />}
    </section>
  );
}

function SaveStatus({ state, onRetry }: { state: SaveState; onRetry(): void }) {
  if (state === "saving") return <span className="save-status muted small">Saving…</span>;
  if (state === "saved") return <span className="save-status ok small">Saved ✓</span>;
  if (state === "error")
    return (
      <span className="save-status error small">
        Couldn't save —{" "}
        <button type="button" className="link inline" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  return null;
}

function RuleEditor({
  rule,
  onChange,
  onDone,
  onRemove,
}: {
  rule: QuietRule;
  onChange(patch: Partial<QuietRule>): void;
  onDone(): void;
  onRemove(): void;
}) {
  const problem = validateRule(rule);
  return (
    <div className="stack">
      <fieldset className="days" aria-describedby="days-help">
        <legend>Days</legend>
        <div className="day-chips">
          {DAY_LABELS.map((label, d) => {
            const on = rule.days.includes(d);
            return (
              <label key={label} className={`day ${on ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onChange({ days: toggleDay(rule.days, d) })}
                />
                {label}
              </label>
            );
          })}
        </div>
        <div className="shortcuts" id="days-help">
          {DAY_SHORTCUTS.map((s) => (
            <button
              key={s.label}
              type="button"
              className="link small"
              onClick={() => onChange({ days: [...s.days] })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="time-fields">
        <label>
          From
          <input
            type="time"
            value={rule.start}
            onChange={(e) => onChange({ start: e.target.value })}
            required
          />
        </label>
        <label>
          Until{spansMidnight(rule) && rule.start !== rule.end && " (next morning)"}
          <input
            type="time"
            value={rule.end}
            onChange={(e) => onChange({ end: e.target.value })}
            required
          />
        </label>
      </div>
      <p className={`small ${problem ? "error" : "muted"}`}>{problem ?? friendlyRule(rule)}</p>
      <div className="row">
        <button type="button" className="primary" onClick={onDone} disabled={!!problem}>
          Done
        </button>
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function WeekChart({ week }: { week: { from: number; to: number }[][] }) {
  return (
    <figure className="card week" aria-label="Quiet hours across the week">
      <figcaption className="small muted">Week at a glance</figcaption>
      <div className="week-grid">
        {week.map((segs, d) => (
          <div key={DAY_LABELS[d]} className="week-row">
            <span className="week-day small">{DAY_LABELS[d]}</span>
            <span className="week-bar">
              {segs.map((s) => (
                <span
                  key={s.from}
                  className="week-seg"
                  style={{
                    left: `${(s.from / 1440) * 100}%`,
                    width: `${((s.to - s.from) / 1440) * 100}%`,
                  }}
                />
              ))}
            </span>
          </div>
        ))}
        <div className="week-row week-axis" aria-hidden="true">
          <span className="week-day" />
          <span className="week-ticks small muted">
            <span>12a</span>
            <span>6a</span>
            <span>12p</span>
            <span>6p</span>
            <span>12a</span>
          </span>
        </div>
      </div>
    </figure>
  );
}
