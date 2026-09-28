import { type FormEvent, useState } from "react";
import type { Api } from "./api.ts";

export function Pair({
  api,
  guardian,
  defaultMine = false,
  onDone,
  onCancel,
}: {
  api: Api;
  /** Non-guardians can only add their own phone. */
  guardian: boolean;
  /** Start with "This is my own phone" ticked (e.g. from the welcome flow). */
  defaultMine?: boolean;
  onDone(): void;
  onCancel(): void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mine, setMine] = useState(!guardian || defaultMine);
  /** Empty = keep what the phone was set up as on its first-run screen. */
  const [kind, setKind] = useState<"" | "kids" | "lounge">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.pair(code, name.trim(), mine || !guardian, mine || !kind ? undefined : kind);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onCancel}>
        ← Back
      </button>
      <h2>Pair a phone</h2>
      <ol className="steps card">
        <li>Plug the phone in and connect it to the internet.</li>
        <li>
          Lift the phone's handset — it reads a 6-digit code aloud (and shows it on the display, if
          the phone has one).
        </li>
        <li>Enter the code below within 10 minutes.</li>
      </ol>
      <UseOldDeviceHint />
      <form className="card stack" onSubmit={(e) => void submit(e)}>
        <label>
          Pairing code
          <input
            className="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            required
          />
        </label>
        <label>
          Phone name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Maya's phone"
            maxLength={24}
            required
          />
          <span className="hint">
            {mine
              ? "The other grown-ups go on its keys; calls to you ring it."
              : "You'll be added to its first key automatically."}
          </span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={mine || !guardian}
            disabled={!guardian}
            onChange={(e) => setMine(e.target.checked)}
          />
          <span>
            This is my own phone
            <span className="hint">
              {guardian
                ? "Leave unticked for a household phone, e.g. a kid's."
                : "You can add your own phone; a guardian adds household phones."}
            </span>
          </span>
        </label>
        {guardian && !mine && (
          <label>
            Kind of phone
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="">As chosen on the phone</option>
              <option value="kids">Kids phone — its own allow-list and speed-dial</option>
              <option value="lounge">
                Lounge phone — shared; people scan it to use it as themselves
              </option>
            </select>
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy || code.length !== 6}>
          {busy ? "Pairing…" : "Pair phone"}
        </button>
      </form>
    </section>
  );
}

/** Any phone, tablet or laptop can be the phone: the browser phone installs as an app. */
export function UseOldDeviceHint() {
  const url = `${location.origin}/device/`;
  return (
    <p className="hint old-device-hint">
      Use an old phone or tablet as the phone: open <a href={url}>{url}</a> on it and choose{" "}
      <strong>Add to Home Screen</strong>. It shows a pairing code to enter here.
    </p>
  );
}
