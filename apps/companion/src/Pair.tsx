import { type FormEvent, useState } from "react";
import type { Api } from "./api.ts";

export function Pair({ api, onDone, onCancel }: { api: Api; onDone(): void; onCancel(): void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.pair(code, name.trim());
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
          Lift the phone's handset — it shows a 6-digit code on its status strip and reads it aloud.
        </li>
        <li>Enter the code below within 10 minutes.</li>
      </ol>
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
          <span className="hint">You'll be added to its first key automatically.</span>
        </label>
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
