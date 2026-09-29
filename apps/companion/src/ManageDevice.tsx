import { useCallback, useEffect, useState } from "react";
import type {
  Api,
  ConnectionView,
  ContactEntry,
  DeviceSummary,
  RemoteContactInfo,
  RoomSummary,
  User,
} from "./api.ts";
import { hostBadge } from "./connectionGroups.ts";
import { GreetingEditor } from "./GreetingEditor.tsx";
import { KeyLabelSheet } from "./KeyLabelSheet.tsx";
import { SPEED_DIAL_ROWS, slotOf } from "./keyLabels.ts";
import { MODE_TEXT } from "./pairMode.ts";
import { formatLastSeen } from "./text.ts";

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
  /** Allow-list entries that come from connections, by their `rc_…` id. */
  const [remote, setRemote] = useState<Map<string, RemoteContactInfo>>(new Map());
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  /** The space's rooms, and which are on this phone (`rk_…` id by room id). */
  const [spaceRooms, setSpaceRooms] = useState<RoomSummary[]>([]);
  const [phoneRooms, setPhoneRooms] = useState<{ id: string; roomId: string; label: string }[]>([]);
  /** A fresh copy of the phone (last seen and software change while it's connected). */
  const [fresh, setFresh] = useState<DeviceSummary>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [u, c, conns, list, rooms] = await Promise.all([
        api.users(),
        api.contacts(deviceId),
        api.connections().catch(() => undefined),
        api.devices().catch(() => undefined),
        api.rooms().catch(() => undefined),
      ]);
      setSpaceRooms(rooms?.rooms ?? []);
      setPhoneRooms(c.rooms ?? []);
      setFresh(list?.find((d) => d.id === deviceId));
      setUsers(u);
      setContacts(c.contacts);
      setButtons(c.buttons);
      setRemote(new Map((c.remote ?? []).map((r) => [r.id, r])));
      setConnections((conns?.connections ?? []).filter((x) => x.state === "active"));
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

  const save = (c: ContactEntry) => {
    const via = remote.get(c.id);
    if (via) {
      const { id: _id, ...flags } = c;
      return run(() => api.putRemoteContact(deviceId, via.connectionId, flags));
    }
    return run(() => api.putContact(deviceId, c));
  };
  const byId = new Map(contacts.map((c) => [c.id, c]));
  // Rooms are on the list too (`rk_…`), but they're edited in their own section.
  const peopleListed = contacts.filter((c) => !c.id.startsWith("rk_"));
  const onPhone = new Set(phoneRooms.map((r) => r.roomId));
  const roomsAddable = spaceRooms.filter((r) => !onPhone.has(r.id));
  const others = users.filter((u) => !byId.has(u.id));
  const listed = new Set([...remote.values()].map((r) => r.connectionId));
  const addable = connections.filter((c) => !listed.has(c.id));

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
          device={fresh ? { ...device, ...fresh } : device}
          meId={meId}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onError={setError}
        />
      )}

      {device && guardian && !device.ownerUserId && device.kind !== "lounge" && (
        <>
          <h3>Voicemail</h3>
          <GreetingEditor api={api} deviceId={device.id} />
        </>
      )}

      <h3>Allowed people</h3>
      <p className="muted small">
        The phone can only call, and be called by, the people listed here.
      </p>
      <ul className="stack">
        {peopleListed.map((c) => (
          <ContactEditor
            key={c.id}
            contact={c}
            via={remote.get(c.id)?.address}
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

      {addable.length > 0 && device?.kind !== "lounge" && (
        <div className="card stack">
          <span className="small muted">
            Add someone you're connected with (another household or server)
          </span>
          <div className="chips">
            {addable.map((c) => (
              <button
                type="button"
                key={c.id}
                title={c.address}
                onClick={() =>
                  void run(() =>
                    api.putRemoteContact(deviceId, c.id, {
                      label: c.name.slice(0, 24),
                      canCallDevice: true,
                      deviceCanCall: true,
                      bypassQuietHours: false,
                    }),
                  )
                }
              >
                + {c.name}
                {hostBadge(c) && <span className="badge">{hostBadge(c)}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {device?.kind !== "lounge" && (
        <>
          <h3>Rooms</h3>
          <p className="muted small">
            Rooms this phone may join with a key (only rooms of this space). Nobody calls the phone
            through them.
          </p>
          <ul className="stack">
            {phoneRooms.map((r) => (
              <li key={r.id} className="row">
                <span>{r.label}</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => void run(() => api.removeRoomFromPhone(deviceId, r.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {roomsAddable.length > 0 && (
            <div className="chips">
              {roomsAddable.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  onClick={() =>
                    void run(() => api.addRoomToPhone(deviceId, r.id, r.name.slice(0, 24)))
                  }
                >
                  + {r.name}
                </button>
              ))}
            </div>
          )}
        </>
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
  via,
  onSave,
  onRemove,
}: {
  contact: ContactEntry;
  /** Their address, for someone from another household or server. */
  via?: string | undefined;
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
      {via && <span className="muted small">Connection: {via}</span>}
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
  onChanged,
  onRemoved,
  onError,
}: {
  api: Api;
  device: DeviceSummary;
  meId: string | undefined;
  onChanged(): void;
  onRemoved(): void;
  onError(msg: string | undefined): void;
}) {
  const [name, setName] = useState(device.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(device.name), [device.name]);
  const someoneElses = !!device.ownerUserId && device.ownerUserId !== meId;
  const mode =
    device.mode ?? (device.kind === "lounge" ? "lounge" : device.ownerUserId ? "personal" : "kids");

  const act = async (fn: () => Promise<unknown>, after: () => void) => {
    onError(undefined);
    setBusy(true);
    try {
      await fn();
      after();
    } catch (e) {
      onError((e as Error).message);
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
      <dl className="phone-facts small">
        <dt>Last seen</dt>
        <dd>{device.online ? "Online now" : formatLastSeen(device.lastSeen, Date.now())}</dd>
        {device.fw && (
          <>
            <dt>Software</dt>
            <dd>
              {device.model === "web-emulator" ? "Browser phone" : (device.model ?? "Phone")}{" "}
              {device.fw}
            </dd>
          </>
        )}
        {device.fingerprint && (
          <>
            <dt>Its words</dt>
            <dd>
              <strong className="words">{device.fingerprint.join(" ")}</strong>
              <span className="hint"> — the phone shows the same under MENU, 0: About.</span>
            </dd>
          </>
        )}
      </dl>
      <p className="small">
        <strong>{MODE_TEXT[mode].title}</strong>
        {someoneElses ? " — another person's own phone." : ` — ${MODE_TEXT[mode].hint}`}
      </p>
      <span className="hint">
        To use it another way or give it to someone else, remove it (it wipes itself) and pair it
        again.
      </span>
      {confirming ? (
        <div className="confirm stack" role="alertdialog" aria-label="Remove this phone?">
          <p className="small">
            The server forgets this phone, and the phone wipes itself — now if it's online, or the
            next time it connects. Nothing stays on it; it can be set up again from scratch.
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
              {busy ? "Removing…" : "Remove and wipe"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="link danger" onClick={() => setConfirming(true)}>
          Remove and wipe
        </button>
      )}
    </div>
  );
}
