import { type FormEvent, useEffect, useState } from "react";
import type { Api } from "./api.ts";
import { allowedModes, initialMode, MODE_TEXT, type PhoneMode } from "./pairMode.ts";

export function Pair({
  api,
  guardian,
  defaultMine = false,
  kidsAllowed = true,
  onDone,
  onCancel,
}: {
  /** False in a team or org space: household phones there are Lounge phones only. */
  kidsAllowed?: boolean;
  api: Api;
  /** Non-guardians can only add their own phone. */
  guardian: boolean;
  /** Start with "My own phone" (e.g. from the welcome flow). */
  defaultMine?: boolean;
  onDone(): void;
  onCancel(): void;
}) {
  const modes = allowedModes(guardian, kidsAllowed);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<PhoneMode>(initialMode(modes, null, defaultMine));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // Once the code is complete: preselect what the phone was set up as.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the code changes
  useEffect(() => {
    if (code.length !== 6) return;
    let live = true;
    api.pairPreview(code).then(
      (p) => {
        if (!live) return;
        setError(undefined);
        setMode(initialMode(modes, p.mode, defaultMine));
      },
      (e) => live && setError((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [api, code]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.pair(code, name.trim(), mode);
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
            placeholder={
              mode === "lounge" ? "Lobby" : mode === "personal" ? "My desk" : "Maya's phone"
            }
            maxLength={24}
            required
          />
          <span className="hint">
            {mode === "personal"
              ? "The other grown-ups go on its keys; calls to you ring it."
              : mode === "kids"
                ? "You'll be added to its first key automatically."
                : "Nothing on its keys until someone signs in."}
          </span>
        </label>
        <fieldset className="choice">
          <legend>How will it be used?</legend>
          {modes.map((m) => (
            <label key={m} className="check">
              <input
                type="radio"
                name="mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>
                {MODE_TEXT[m].title}
                <span className="hint"> — {MODE_TEXT[m].hint}</span>
              </span>
            </label>
          ))}
          {!guardian && (
            <span className="hint">You can add your own phone; a guardian adds the others.</span>
          )}
        </fieldset>
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
