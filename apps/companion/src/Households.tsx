import { type FormEvent, useState } from "react";
import type { Api, Membership } from "./api.ts";
import { type SpaceType, spaceNoun } from "./spaces.ts";

/** Top-bar picker between the households you belong to (shown when there's more than one). */
export function HouseholdSwitcher({
  memberships,
  activeId,
  onSwitch,
  onAdd,
}: {
  memberships: Membership[];
  activeId: string | undefined;
  onSwitch(householdId: string): void;
  onAdd(): void;
}) {
  if (memberships.length < 2) return null;
  return (
    <select
      className="household-switch"
      aria-label="Household or team"
      value={activeId ?? ""}
      onChange={(e) => {
        if (e.target.value === "+") onAdd();
        else if (e.target.value !== activeId) onSwitch(e.target.value);
      }}
    >
      {memberships.map((m) => (
        <option key={m.householdId} value={m.householdId}>
          {m.householdName}
          {m.spaceType && m.spaceType !== "home" ? ` (${spaceNoun(m.spaceType)})` : ""}
        </option>
      ))}
      <option value="+">+ Add a household or team…</option>
    </select>
  );
}

/** The three things a guardian sets up: a kid's phone, a co-guardian, another household. */
export function GetStarted({
  onAddKidPhone,
  onInviteGuardian,
  onAddHousehold,
  spaceType,
}: {
  onAddKidPhone(): void;
  onInviteGuardian(): void;
  onAddHousehold(): void;
  spaceType?: SpaceType | undefined;
}) {
  const home = (spaceType ?? "home") === "home";
  return (
    <section className="card stack get-started" aria-labelledby="get-started">
      <h3 id="get-started">Set up</h3>
      <div className="get-started-actions">
        {home && (
          <button type="button" onClick={onAddKidPhone}>
            Add a kid's phone
          </button>
        )}
        <button type="button" onClick={onInviteGuardian}>
          {home ? "Invite a co-guardian" : `Invite someone to this ${spaceNoun(spaceType)}`}
        </button>
        <button type="button" onClick={onAddHousehold}>
          Add a household
        </button>
      </div>
    </section>
  );
}

/** "Add a household": e.g. Grandma's place, or a second home. You become its guardian. */
export function AddHousehold({
  api,
  onCreated,
  onCancel,
}: {
  api: Api;
  onCreated(householdId: string): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<SpaceType>("home");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const noun = spaceNoun(type);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { household } = await api.createHousehold({ name: name.trim(), type });
      onCreated(household.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <form className="stack" onSubmit={(e) => void submit(e)}>
      <button type="button" className="link back" onClick={onCancel}>
        ← Back
      </button>
      <h2>Add a {noun}</h2>
      <fieldset className="stack">
        <legend>What kind?</legend>
        <label className="check">
          <input type="radio" checked={type === "home"} onChange={() => setType("home")} />
          <span>
            <strong>A household</strong>
            <span className="muted small"> — a home with kids' phones, people and quiet hours</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={type === "team"} onChange={() => setType("team")} />
          <span>
            <strong>A team</strong>
            <span className="muted small"> — grown-ups working together; no kids' phones</span>
          </span>
        </label>
        <label className="check">
          <input type="radio" checked={type === "org"} onChange={() => setType("org")} />
          <span>
            <strong>An organization</strong>
            <span className="muted small"> — a club, office or venue with Lounge phones</span>
          </span>
        </label>
      </fieldset>
      <p className="muted">
        {type === "home"
          ? "A separate home with its own phones, people and quiet hours — for example Grandma's place, or the other parent's home."
          : `A ${noun} for grown-ups: their own phones and shared Lounge phones.`}{" "}
        You'll be its guardian and can switch at the top.
      </p>
      <label>
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={type === "home" ? "Grandma's place" : type === "team" ? "Studio" : "Club"}
          maxLength={64}
          required
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Creating…" : `Create ${noun}`}
      </button>
    </form>
  );
}

/** Account page section: your households, with switching. */
export function YourHouseholds({
  memberships,
  activeId,
  onSwitch,
  onAdd,
}: {
  memberships: Membership[];
  activeId: string | undefined;
  onSwitch(householdId: string): void;
  onAdd(): void;
}) {
  return (
    <>
      <h3>Your households and teams</h3>
      <ul className="stack">
        {memberships.map((m) => (
          <li key={m.householdId} className="card person">
            <div>
              <div className="device-name">{m.householdName}</div>
              <div className="muted small">
                {m.spaceType && m.spaceType !== "home" ? `${spaceNoun(m.spaceType)} · ` : ""}
                {m.role === "guardian" ? "Guardian" : "Member"} as {m.name}
              </div>
            </div>
            {m.householdId === activeId ? (
              <span className="muted small">Current</span>
            ) : (
              <button type="button" onClick={() => onSwitch(m.householdId)}>
                Switch
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onAdd}>
        Add a household or team
      </button>
    </>
  );
}
