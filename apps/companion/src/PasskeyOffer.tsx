import { useEffect, useState } from "react";
import { createApi } from "./api.ts";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";

/** After joining or setting up: offer to add a passkey for this device. Always skippable. */
export function PasskeyOffer({ token, onDone }: { token: string; onDone(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported = passkeysSupported();
  useEffect(() => {
    if (!supported) onDone();
  }, [supported, onDone]);
  if (!supported) return null;
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await registerPasskey(createApi({ token }), defaultPasskeyName(navigator.userAgent));
      onDone();
    } catch (e) {
      setError(passkeyErrorText(e));
      setBusy(false);
    }
  };
  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Stay signed in safely</h1>
        <p>
          Add a passkey so you can sign in on this device next time with your fingerprint, face or
          screen lock — no password needed.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="primary" disabled={busy} onClick={() => void add()}>
          {busy ? "Waiting for your device…" : "Add a passkey"}
        </button>
        <button type="button" className="link" onClick={onDone}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
