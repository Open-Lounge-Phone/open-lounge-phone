import { useCallback, useEffect, useState } from "react";
import type { Api, ContactEntry, DeviceSummary, User } from "./api.ts";
import { KeyLabelSheet } from "./KeyLabelSheet.tsx";
import { SPEED_DIAL_ROWS, slotOf } from "./keyLabels.ts";

interface Props {
  api: Api;
  deviceId: string;
  device: DeviceSummary | undefined;
  meId: string | undefined;
  guardian: boolean;
  onBack(): void;
  /** Name/ownership changed: the caller re-reads the phone list. */
  onChanged(): void;
  /** The phone was removed. */
  onRemoved(): void;
}

export function ManageDevice({
  api,
  deviceId,
  device,
  meId,
  guardian,
  onBack,
  onChanged,
  onRemoved,
}: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [buttons, setButtons] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([api.users(), api.contacts(deviceId)]);
      setUsers(u);
      setContacts(c.contacts);
      setButtons(c.buttons);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const save = (c: ContactEntry) => run(() => api.putContact(deviceId, c));
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const others = users.filter((u) => !byId.has(u.id));

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>{device?.name ?? "Phone"}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {device && (
        <PhoneSettings
          api={api}
          device={device}
          meId={meId}
          guardian={guardian}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onError={setError}
        />
      )}

      <h3>Allowed people</h3>
      <p className="muted small">
        The phone can only call, and be called by, the people listed here.
      </p>
      <ul className="stack">
        {contacts.map((c) => (
          <ContactEditor
            key={c.id}
            contact={c}
            onSave={save}
            onRemove={() => run(() => api.deleteContact(deviceId, c.id))}
          />
        ))}
      </ul>
      {others.length > 0 && (
        <div className="card stack">
          <span className="small muted">Add someone from your household</span>
          <div className="chips">
            {others.map((u) => (
              <button
                type="button"
                key={u.id}
                onClick={() =>
                  void save({
                    id: u.id,
                    label: u.name,
                    canCallDevice: true,
                    deviceCanCall: true,
                    bypassQuietHours: false,
                  })
                }
              >
                + {u.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <h3>Keys</h3>
      <p className="muted small">
        Lift the handset and press a digit to call that person (speed dial). Only people the phone
        is allowed to call light up.
      </p>
      <div className="card keys">
        {SPEED_DIAL_ROWS.flat().map((digit) => {
          const slot = slotOf(digit);
          const assigned = buttons[String(slot)] ?? "";
          return (
            <label key={digit} className="key-row">
              <span className="keycap" title={`Key ${digit}`}>
                {digit}
              </span>
              <select
                aria-label={`Key ${digit}`}
                value={assigned}
                onChange={(e) =>
                  void run(() => api.setButton(deviceId, slot, e.target.value || null))
                }
              >
                <option value="">— nobody —</option>
                {contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {c.deviceCanCall ? "" : " (can't be called)"}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
      <KeyLabelSheet buttons={buttons} contacts={contacts} />
    </section>
  );
}

function ContactEditor({
  contact,
  onSave,
  onRemove,
}: {
  contact: ContactEntry;
  onSave(c: ContactEntry): void;
  onRemove(): void;
}) {
  const [label, setLabel] = useState(contact.label);
  useEffect(() => setLabel(contact.label), [contact.label]);
  const toggle = (k: "canCallDevice" | "deviceCanCall" | "bypassQuietHours") =>
    onSave({ ...contact, [k]: !contact[k] });

  return (
    <li className="card stack contact">
      <div className="row">
        <input
          aria-label="Name shown for this person"
          value={label}
          maxLength={24}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => {
            const trimmed = label.trim();
            if (trimmed && trimmed !== contact.label) onSave({ ...contact, label: trimmed });
            else setLabel(contact.label);
          }}
        />
        <button type="button" className="danger" onClick={onRemove}>
          Remove
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={contact.canCallDevice}
          onChange={() => toggle("canCallDevice")}
        />
        Can call the phone
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={contact.deviceCanCall}
          onChange={() => toggle("deviceCanCall")}
        />
        Phone can call them
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={contact.bypassQuietHours}
          onChange={() => toggle("bypassQuietHours")}
        />
        Rings during quiet hours
      </label>
    </li>
  );
}

/** Name, whose phone it is, and removal. */
function PhoneSettings({
  api,
  device,
  meId,
  guardian,
  onChanged,
  onRemoved,
  onError,
}: {
  api: Api;
  device: DeviceSummary;
  meId: string | undefined;
  guardian: boolean;
  onChanged(): void;
  onRemoved(): void;
  onError(msg: string | undefined): void;
}) {
  const [name, setName] = useState(device.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(device.name), [device.name]);
  const serverMine = !!meId && device.ownerUserId === meId;
  const someoneElses = !!device.ownerUserId && !serverMine;
  // Optimistic: reflect the choice immediately, fall back to the server's value on error.
  const [mine, setMine] = useState(serverMine);
  useEffect(() => setMine(serverMine), [serverMine]);
  const setOwner = (me: boolean) => {
    setMine(me);
    void act(() => api.updateDevice(device.id, { owner: me ? "me" : "household" }), onChanged).then(
      () => undefined,
    );
  };

  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    onError(undefined);
    setBusy(true);
    try {
      await fn();
      after();
    } catch (e) {
      onError((e as Error).message);
      setMine(serverMine);
    } finally {
      setBusy(false);
    }
  };

  const rename = () => {
    const next = name.trim();
    if (!next || next === device.name) return setName(device.name);
    void act(() => api.updateDevice(device.id, { name: next }), onChanged);
  };

  return (
    <div className="card stack">
      <label>
        Phone name
        <input
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </label>
      {!someoneElses && (
        <fieldset className="stack ownership" disabled={busy}>
          <legend>Whose phone is this?</legend>
          <label className="check">
            <input type="radio" name="owner" checked={mine} onChange={() => setOwner(true)} />
            <span>This is my phone</span>
          </label>
          <label className="check">
            <input
              type="radio"
              name="owner"
              checked={!mine}
              disabled={!guardian && !mine}
              onChange={() => setOwner(false)}
            />
            <span>Household phone (e.g. a kid's)</span>
          </label>
          <span className="hint">
            Calls to you ring your own phone. Quiet hours only apply to household phones.
          </span>
        </fieldset>
      )}
      {someoneElses && <p className="muted small">This is another person's own phone.</p>}
      {confirming ? (
        <div className="confirm stack" role="alertdialog" aria-label="Remove this phone?">
          <p className="small">
            Removes it from your household. A virtual phone will show a new pairing code.
          </p>
          <div className="row">
            <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void act(() => api.removeDevice(device.id), onRemoved)}
            >
              {busy ? "Removing…" : "Remove phone"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="link danger" onClick={() => setConfirming(true)}>
          Remove phone
        </button>
      )}
    </div>
  );
}
