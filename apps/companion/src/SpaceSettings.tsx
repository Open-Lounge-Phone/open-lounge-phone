// A space's Settings page: its name and time zone, its privacy settings, and (for the people who
// run it) the list of changes made in it. Everyone in the space sees the values; guardians of a
// home, or the owner and admins of a team or organization, change them.
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { Api, AuditEntry, Household } from "./api.ts";
import { auditText } from "./auditText.ts";
import { requiredProblem } from "./fields.ts";
import { SpacePrivacy } from "./SpacePrivacy.tsx";
import { kidSafe, spaceNoun } from "./spaces.ts";
import { TimeZonePicker } from "./TimeZonePicker.tsx";
import { zoneLabel, zoneProblem } from "./timeZones.ts";

export function SpaceSettings({
  api,
  household,
  canEdit,
  onChanged,
  onBack,
}: {
  api: Api;
  household: Household;
  /** A guardian of a home, or the owner or an admin of a team or organization. */
  canEdit: boolean;
  /** The name or time zone changed (reload the space everywhere). */
  onChanged(): void;
  onBack(): void;
}) {
  const noun = spaceNoun(household.type);
  const title = `${noun[0]?.toUpperCase()}${noun.slice(1)} settings`;
  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>{title}</h2>
      {canEdit ? (
        <NameAndZone api={api} household={household} onChanged={onChanged} />
      ) : (
        <div className="card stack">
          <div>
            <div className="muted small">Name</div>
            <div>{household.name}</div>
          </div>
          <div>
            <div className="muted small">Time zone</div>
            <div>{zoneLabel(household.timeZone)}</div>
          </div>
          <span className="hint">
            {kidSafe(household.type)
              ? "Guardians can change these."
              : "The owner and admins can change these."}
          </span>
        </div>
      )}
      <SpacePrivacy api={api} guardian={canEdit} />
      {canEdit && <Changes api={api} home={kidSafe(household.type)} />}
    </section>
  );
}

function NameAndZone({
  api,
  household,
  onChanged,
}: {
  api: Api;
  household: Household;
  onChanged(): void;
}) {
  const [name, setName] = useState(household.name);
  const [timeZone, setTimeZone] = useState(household.timeZone);
  const [nameProblem, setNameProblem] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = name.trim() !== household.name || timeZone !== household.timeZone;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = requiredProblem(name, "a name");
    setNameProblem(problem);
    if (problem || zoneProblem(timeZone) || !changed) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.updateSpace({
        ...(name.trim() !== household.name ? { name: name.trim() } : {}),
        ...(timeZone !== household.timeZone ? { timeZone } : {}),
      });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const home = kidSafe(household.type);
  return (
    <form className="card stack" noValidate onSubmit={(e) => void submit(e)}>
      <label>
        Name
        <input
          value={name}
          maxLength={64}
          aria-invalid={nameProblem ? true : undefined}
          onChange={(e) => {
            setName(e.target.value);
            setNameProblem(undefined);
            setSaved(false);
          }}
        />
        <span className={nameProblem ? "hint error" : "hint"}>
          {nameProblem ?? "Shown at the top of the app and on the phones."}
        </span>
      </label>
      <TimeZonePicker
        value={timeZone}
        onChange={(z) => {
          setTimeZone(z);
          setSaved(false);
        }}
        hint={
          home
            ? "Quiet hours, the phones' clocks and the end of the day follow it."
            : "Opening hours, the phones' clocks and the end of the day follow it."
        }
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {saved && !changed && <p className="muted small">Saved. The phones have it now.</p>}
      <button type="submit" className="primary" disabled={busy || !changed}>
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** What was changed here, by whom and when (the audit trail), newest first. */
function Changes({ api, home }: { api: Api; home: boolean }) {
  const [entries, setEntries] = useState<AuditEntry[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.audit().then(setEntries, (e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);
  return (
    <div className="card stack">
      <h3>Changes</h3>
      <p className="hint">
        Who changed what here, and when. Only {home ? "guardians" : "the owner and admins"} see this
        list; nobody can edit it. It never holds what was said or written. It's kept as long as the
        call history above.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {entries && entries.length === 0 && <p className="muted small">No changes yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="stack">
          {entries.map((e) => (
            <li key={e.id} className="small">
              <span className="muted">{new Date(e.at).toLocaleString()}</span> · {e.actorName}{" "}
              {auditText(e.action, e.detail)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
