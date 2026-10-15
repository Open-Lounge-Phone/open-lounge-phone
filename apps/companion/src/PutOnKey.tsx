// "Put on a key": an add-on (or a share of one) on a key of one of your own phones, in one step.
// The phone is preselected when you have one, and so is its first free key; the button names the
// key it will use. Kids' phones never take add-ons, and aren't offered.
import { useEffect, useState } from "react";
import { firstFreeSlot, keyLabelFor } from "./addonText.ts";
import type { Api, ContactEntry, DeviceSummary } from "./api.ts";
import { SPEED_DIAL_ROWS, slotOf } from "./keyLabels.ts";

const DIGITS = SPEED_DIAL_ROWS.flat();

/** A digit key's number, from its slot (slot 9 is the 0 key). */
const digitOf = (slot: number) => (slot === 9 ? 0 : slot + 1);

export function PutOnKey({
  api,
  devices,
  meId,
  address,
  label,
  shareLabel,
  onDone,
  onCancel,
}: {
  api: Api;
  devices: DeviceSummary[];
  meId: string | undefined;
  /** What the key calls: `handle+name@host` or `handle+name+share@host`. */
  address: string;
  /** The key's label (its name, or "name · share"). */
  label: string;
  /** Putting a share on the key: hardware phones show the add-on's name without it. */
  shareLabel?: string | undefined;
  onDone(text: string): void;
  onCancel(): void;
}) {
  const phones = devices.filter((d) => d.mode === "personal" && d.ownerUserId === meId);
  const onlyKids = !phones.length && devices.some((d) => d.mode === "kids" || d.kind === "kids");
  const [phoneId, setPhoneId] = useState(phones[0]?.id ?? "");
  const [keys, setKeys] = useState<{ buttons: Record<string, string>; contacts: ContactEntry[] }>();
  const [slot, setSlot] = useState<number>();
  const [name, setName] = useState(keyLabelFor(label));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const phone = phones.find((p) => p.id === phoneId);

  useEffect(() => {
    if (!phoneId) return;
    setKeys(undefined);
    api.contacts(phoneId).then(
      (c) => {
        setKeys({ buttons: c.buttons, contacts: c.contacts });
        setSlot(firstFreeSlot(c.buttons, DIGITS.map(slotOf)));
      },
      (e: Error) => setError(e.message),
    );
  }, [api, phoneId]);

  if (!phones.length) {
    return (
      <div className="card stack put-on-key" role="status">
        <p>
          {onlyKids
            ? "Kids' phones can't call add-ons. Put it on a phone of your own: add one on Home with Add a phone, choosing that it's yours."
            : "You don't have a phone of your own in this space yet. Add one on Home with Add a phone, choosing that it's yours."}
        </p>
        <div className="row">
          <button type="button" className="link" onClick={onCancel}>
            OK
          </button>
        </div>
      </div>
    );
  }

  const byId = new Map((keys?.contacts ?? []).map((c) => [c.id, c.label]));
  const current = (s: number) => byId.get(keys?.buttons[String(s)] ?? "") ?? "";
  const taken = slot !== undefined ? current(slot) : "";
  const hardware = phone?.model === "esp32s3";

  const put = async () => {
    if (slot === undefined || !name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addLineToPhone(phoneId, address, name.trim(), slot);
      onDone(`${name.trim()} is on key ${digitOf(slot)} of ${phone?.name ?? "your phone"}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack put-on-key">
      <h3>Put on a key</h3>
      {phones.length > 1 ? (
        <label>
          Phone
          <select value={phoneId} onChange={(e) => setPhoneId(e.target.value)}>
            {phones.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted small">On {phone?.name}, your own phone.</p>
      )}
      <fieldset className="key-pick">
        <legend>Key</legend>
        {!keys && <p className="muted small">Reading its keys…</p>}
        {keys && (
          <div className="key-grid">
            {DIGITS.map((d) => {
              const s = slotOf(d);
              const on = current(s);
              return (
                <button
                  key={d}
                  type="button"
                  className={`key-choice${slot === s ? " chosen" : ""}`}
                  aria-pressed={slot === s}
                  aria-label={`Key ${d}${on ? `, now ${on}` : ", free"}`}
                  onClick={() => setSlot(s)}
                >
                  <span className="keycap">{d}</span>
                  <span className="small muted">{on || "free"}</span>
                </button>
              );
            })}
          </div>
        )}
      </fieldset>
      <label>
        Key label
        <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
      </label>
      {taken && slot !== undefined && (
        <p className="hint">
          Key {digitOf(slot)} calls {taken} now; it will call {name.trim() || "this"} instead.
        </p>
      )}
      {hardware && shareLabel && (
        <p className="hint">
          This phone shows the add-on's name with ADD-ON while calling, without "{shareLabel}".
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || slot === undefined || !keys || !name.trim()}
          onClick={() => void put()}
        >
          {slot === undefined ? "Put on a key" : `Put on key ${digitOf(slot)}`}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
