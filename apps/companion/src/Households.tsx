import { type FormEvent, useState } from "react";
import type { Api, Membership } from "./api.ts";

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
      aria-label="Household"
      value={activeId ?? ""}
      onChange={(e) => {
        if (e.target.value === "+") onAdd();
        else if (e.target.value !== activeId) onSwitch(e.target.value);
      }}
    >
      {memberships.map((m) => (
        <option key={m.householdId} value={m.householdId}>
          {m.householdName}
        </option>
      ))}
      <option value="+">+ Add a household…</option>
    </select>
  );
}

/** The three things a guardian sets up: a kid's phone, a co-guardian, another household. */
export function GetStarted({
  onAddKidPhone,
  onInviteGuardian,
  onAddHousehold,
}: {
  onAddKidPhone(): void;
  onInviteGuardian(): void;
  onAddHousehold(): void;
}) {
  return (
    <section className="card stack get-started" aria-labelledby="get-started">
      <h3 id="get-started">Set up</h3>
      <div className="get-started-actions">
        <button type="button" onClick={onAddKidPhone}>
          Add a kid's phone
        </button>
        <button type="button" onClick={onInviteGuardian}>
          Invite a co-guardian
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { household } = await api.createHousehold({ name: name.trim() });
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
      <h2>Add a household</h2>
      <p className="muted">
        A separate home with its own phones, people and quiet hours — for example Grandma's place,
        or the other parent's home. You'll be its guardian and can switch between households at the
        top.
      </p>
      <label>
        Household name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Grandma's place"
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
        {busy ? "Creating…" : "Create household"}
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
      <h3>Your households</h3>
      <ul className="stack">
        {memberships.map((m) => (
          <li key={m.householdId} className="card person">
            <div>
              <div className="device-name">{m.householdName}</div>
              <div className="muted small">
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
        Add a household
      </button>
    </>
  );
}
