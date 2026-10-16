import { leftPhoneName } from "@openloungephone/core";
import { useCallback, useEffect, useState } from "react";
import { addonAddressProblem, isAddonAddress } from "./addonText.ts";
import type {
  Api,
  ConnectionView,
  ContactEntry,
  DeviceSummary,
  RemoteContactInfo,
  RoomSummary,
  User,
} from "./api.ts";
import { CallWaitingToggle } from "./CallWaiting.tsx";
import { hostBadge } from "./connectionGroups.ts";
import { addressProblem, requiredProblem } from "./fields.ts";
import { GreetingEditor } from "./GreetingEditor.tsx";
import { HomeFeaturesCard } from "./HomeFeatures.tsx";
import { KeyLabelSheet } from "./KeyLabelSheet.tsx";
import { KeyPages } from "./KeyPages.tsx";
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
  /** How many pages of ten keys the phone may have (the server says). */
  const [keyPages, setKeyPages] = useState(1);
  /** Allow-list entries that come from connections, by their `rc_…` id. */
  const [remote, setRemote] = useState<Map<string, RemoteContactInfo>>(new Map());
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  /** The space's rooms, and which are on this phone (`rk_…` id by room id). */
  const [spaceRooms, setSpaceRooms] = useState<RoomSummary[]>([]);
  const [phoneRooms, setPhoneRooms] = useState<{ id: string; roomId: string; label: string }[]>([]);
  /** Public lines on this phone's keys (`ln_…`). */
  const [phoneLines, setPhoneLines] = useState<{ id: string; address: string; label: string }[]>(
    [],
  );
  const [lineAddress, setLineAddress] = useState("");
  const [lineLabel, setLineLabel] = useState("");
  const [lineProblem, setLineProblem] = useState<string>();
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
      setPhoneLines(c.lines ?? []);
      setFresh(list?.find((d) => d.id === deviceId));
      setUsers(u);
      setContacts(c.contacts);
      setButtons(c.buttons);
      setKeyPages(c.keyPages ?? 1);
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
  const peopleListed = contacts.filter((c) => !c.id.startsWith("rk_") && !c.id.startsWith("ln_"));
  const onPhone = new Set(phoneRooms.map((r) => r.roomId));
  const roomsAddable = spaceRooms.filter((r) => !onPhone.has(r.id));
  const others = users.filter((u) => !byId.has(u.id));
  const listed = new Set([...remote.values()].map((r) => r.connectionId));
  const addable = connections.filter((c) => !listed.has(c.id));

  // The phone of someone who left: rename, set it up again or remove it; nothing else changes
  // until it's set up again (the server refuses that too).
  if (device?.mode === "left") {
    const mayCall = peopleListed.filter((c) => c.deviceCanCall);
    return (
      <section className="stack">
        <button type="button" className="link back" onClick={onBack}>
          ← Back
        </button>
        <h2>{leftPhoneName(device.name, device.leftBy ?? "")}</h2>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <PhoneSettings
          api={api}
          device={fresh ? { ...device, ...fresh } : device}
          meId={meId}
          onChanged={onChanged}
          onRemoved={onRemoved}
          onError={setError}
        />
        <h3>Who it can call</h3>
        <p className="muted small">
          {mayCall.length
            ? `${mayCall.map((c) => c.label).join(", ")}, with its keys (quiet hours apply).`
            : "Nobody."}{" "}
          Nobody can call it.
        </p>
      </section>
    );
  }

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
          <h3>Calls</h3>
          <CallWaitingToggle api={api} deviceId={device.id} />
        </>
      )}

      {device && (guardian || device.ownerUserId === meId) && device.kind !== "lounge" && (
        <>
          <h3>Home features</h3>
          <HomeFeaturesCard api={api} deviceId={device.id} />
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

      {device?.ownerUserId && device.kind !== "lounge" && (
        <>
          <h3>Public lines and add-ons</h3>
          <p className="muted small">
            A business's line, like support@example.org: anyone may call it without connecting
            first. Or an add-on you may talk to, like your own you+seat@example.org. Put one on a
            key below. (Kids' phones can't call either.)
          </p>
          <ul className="stack">
            {phoneLines.map((l) => (
              <li key={l.id} className="row">
                <span className="grow">
                  {l.label} <span className="muted small">{l.address}</span>
                </span>
                <button
                  type="button"
                  className="link"
                  onClick={() => void run(() => api.removeLineFromPhone(deviceId, l.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="stack"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const problem =
                (isAddonAddress(lineAddress.trim())
                  ? addonAddressProblem(lineAddress)
                  : addressProblem(lineAddress)) ??
                requiredProblem(lineLabel, "a label for its key");
              setLineProblem(problem);
              if (problem) return;
              setError(undefined);
              api.addLineToPhone(deviceId, lineAddress.trim().toLowerCase(), lineLabel.trim()).then(
                () => {
                  setLineAddress("");
                  setLineLabel("");
                  void load();
                },
                (err: Error) => setLineProblem(err.message),
              );
            }}
          >
            <div className="row wrap">
              <label>
                <span className="muted small">Address</span>
                <input
                  value={lineAddress}
                  onChange={(e) => {
                    setLineAddress(e.target.value);
                    setLineProblem(undefined);
                  }}
                  inputMode="email"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>
              <label>
                <span className="muted small">Key label</span>
                <input
                  maxLength={24}
                  value={lineLabel}
                  onChange={(e) => {
                    setLineLabel(e.target.value);
                    setLineProblem(undefined);
                  }}
                />
              </label>
              <button type="submit">Add</button>
            </div>
            <span className={lineProblem ? "hint error" : "hint"}>
              {lineProblem ?? "For example, support@example.org with the label Support."}
            </span>
          </form>
        </>
      )}

      <h3>Keys</h3>
      <p className="muted small">
        Lift the handset and press a digit to call that person (speed dial). Only people the phone
        is allowed to call light up.
      </p>
      <KeyPages
        buttons={buttons}
        contacts={contacts}
        maxPages={keyPages}
        onSet={(index, userId) => run(() => api.setButton(deviceId, index, userId))}
        onMove={(changes) =>
          run(async () => {
            for (const c of changes) await api.setButton(deviceId, c.index, c.userId);
          })
        }
      />
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
  const left = device.mode === "left";
  const mode =
    device.mode === "left"
      ? "kids"
      : (device.mode ??
        (device.kind === "lounge" ? "lounge" : device.ownerUserId ? "personal" : "kids"));

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
      {left ? (
        <p className="small">
          <strong>Phone of someone who left</strong> —{" "}
          {device.leftBy ? `${device.leftBy} left` : "Its owner left"}
          {device.leftAt ? ` on ${new Date(device.leftAt).toLocaleDateString()}` : ""}. Nobody can
          call it, and it calls only the people below, like a kids' phone (quiet hours apply, no
          add-ons or lines, no voicemail from it).
        </p>
      ) : (
        <p className="small">
          <strong>{MODE_TEXT[mode].title}</strong>
          {someoneElses ? " — another person's own phone." : ` — ${MODE_TEXT[mode].hint}`}
        </p>
      )}
      <span className="hint">
        {left
          ? "To set it up again for someone, press Set it up again: it wipes itself and shows a new code; then pair it with that code (Pair a phone)."
          : "To use it another way or give it to someone else, remove it (it wipes itself) and pair it again."}
      </span>
      {left && !confirming && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(() => api.removeDevice(device.id), onRemoved)}
        >
          {busy ? "Wiping…" : "Set it up again"}
        </button>
      )}
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
