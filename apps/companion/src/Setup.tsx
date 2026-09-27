import { type FormEvent, useState } from "react";
import { createApi } from "./api.ts";
import { passkeyErrorText, passkeysSupported, signInWithPasskey } from "./passkeys.ts";
import { defaultTimeZone } from "./session.ts";

export function Setup({ setupToken, onDone }: { setupToken: string; onDone(token: string): void }) {
  const [householdName, setHouseholdName] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await createApi({ token: null }).setup({
        token: setupToken,
        householdName,
        guardianName,
        timeZone,
      });
      onDone(res.token);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="card stack" onSubmit={(e) => void submit(e)}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Welcome to OpenTinCan</h1>
        <p className="muted">
          Set up your household. You'll be its first guardian and can pair phones and choose who
          they can call.
        </p>
        <label>
          Household name
          <input
            value={householdName}
            onChange={(e) => setHouseholdName(e.target.value)}
            placeholder="The Garcia home"
            maxLength={64}
            required
          />
        </label>
        <label>
          Your name
          <input
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            placeholder="Mom"
            maxLength={24}
            required
          />
          <span className="hint">This is how you appear on the phone's keys.</span>
        </label>
        <label>
          Time zone
          <input value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required />
          <span className="hint">Used for quiet hours.</span>
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
    </div>
  );
}

export function SignedOut({ onToken }: { onToken(token: string): void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported = passkeysSupported();

  const passkey = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await signInWithPasskey(createApi({ token: null }));
      onToken(res.token);
    } catch (e) {
      setError(passkeyErrorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>OpenTinCan</h1>
        {supported && (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void passkey()}
            >
              {busy ? "Waiting for your device…" : "Sign in with a passkey"}
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <p>
          New here? Open the invite link a guardian sent you. If you're setting up a new server,
          open the setup link it printed when it first started.
        </p>
        <p className="muted">Lost your passkey? Ask a guardian for a new sign-in link.</p>
        <details>
          <summary>Developer sign-in</summary>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim().length >= 16) onToken(token.trim());
            }}
          >
            <label>
              Session token
              <input value={token} onChange={(e) => setToken(e.target.value)} />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </details>
      </div>
    </div>
  );
}
