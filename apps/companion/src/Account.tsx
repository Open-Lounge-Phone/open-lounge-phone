import { useCallback, useEffect, useState } from "react";
import type { Api, PasskeySummary, User } from "./api.ts";
import { AvailabilityToggle } from "./GrownUps.tsx";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";
import { formatWhen } from "./text.ts";

interface Props {
  api: Api;
  me: User | undefined;
  available: boolean;
  onAvailable(v: boolean): void;
  onBack(): void;
  onSignOut(): void;
}

export function Account({ api, me, available, onAvailable, onBack, onSignOut }: Props) {
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [name, setName] = useState(() => defaultPasskeyName(navigator.userAgent));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const supported = passkeysSupported();

  const load = useCallback(async () => {
    try {
      setPasskeys(await api.passkeys());
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await registerPasskey(api, name.trim() || "Passkey");
      setNotice("Passkey added. Next time, choose “Sign in with a passkey”.");
    } catch (e) {
      setError(passkeyErrorText(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (id: string) => {
    setError(undefined);
    try {
      await api.removePasskey(id);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  const now = Date.now();

  return (
    <section className="stack">
      <button type="button" className="link back" onClick={onBack}>
        ← Back
      </button>
      <h2>{me ? me.name : "Account"}</h2>
      <AvailabilityToggle available={available} onChange={onAvailable} />
      {me && (
        <p className="muted">{me.role === "guardian" ? "Guardian" : "Contact"} in this household</p>
      )}

      <h3>Your passkeys</h3>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="ok">{notice}</p>}
      {passkeys.length === 0 && (
        <p className="muted">
          No passkeys yet. Without one, you'll need a new sign-in link if you're signed out.
        </p>
      )}
      <ul className="stack">
        {passkeys.map((p) => (
          <li key={p.id} className="card person">
            <div>
              <div className="device-name">{p.name}</div>
              <div className="muted small">
                Added {formatWhen(p.createdAt, now)}
                {p.lastUsedAt ? ` · last used ${formatWhen(p.lastUsedAt, now)}` : ""}
              </div>
            </div>
            <button type="button" className="danger" onClick={() => void remove(p.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {supported ? (
        <div className="card stack">
          <label>
            Name for this device's passkey
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </label>
          <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
            {busy ? "Waiting for your device…" : "Add a passkey on this device"}
          </button>
        </div>
      ) : (
        <p className="muted">
          This browser can't create passkeys here. Passkeys need HTTPS (or localhost).
        </p>
      )}

      <h3>Session</h3>
      <button type="button" onClick={onSignOut}>
        Sign out of this device
      </button>
    </section>
  );
}
