import { useCallback, useEffect, useState } from "react";
import type { Api, ContactEntry, DeviceSummary, User } from "./api.ts";

const KEY_COUNT = 8;

interface Props {
  api: Api;
  deviceId: string;
  device: DeviceSummary | undefined;
  onBack(): void;
}

export function ManageDevice({ api, deviceId, device, onBack }: Props) {
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
        Each key on the phone calls one person. Only people the phone is allowed to call light up.
      </p>
      <div className="card keys">
        {Array.from({ length: KEY_COUNT }, (_, i) => {
          const assigned = buttons[String(i)] ?? "";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: keys are positional
            <label key={i} className="key-row">
              <span className="keycap">{i + 1}</span>
              <select
                value={assigned}
                onChange={(e) => void run(() => api.setButton(deviceId, i, e.target.value || null))}
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
