import { useEffect, useState } from "react";
import { createApi } from "./api.ts";
import { PasskeyHelp } from "./PasskeyHelp.tsx";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";

/**
 * After joining or setting up: offer to add a passkey for this device. Always skippable.
 * `another`: signed in with a passkey from another device (a phone by QR code); this one can
 * make its own.
 */
export function PasskeyOffer({
  token,
  onDone,
  another = false,
}: {
  token: string;
  onDone(): void;
  another?: boolean;
}) {
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
        <h1>{another ? "Add a passkey on this device?" : "Stay signed in safely"}</h1>
        <p>
          {another
            ? "You signed in with a passkey from another device. Add one here too, so next time this device signs you in by itself, with its fingerprint, face or screen lock."
            : "Add a passkey so you can sign in on this device next time with your fingerprint, face or screen lock — no password needed."}
        </p>
        <PasskeyHelp />
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
        <p className="muted small">
          {another
            ? "Skipping is fine: you'll sign in from your other device again next time."
            : "Without a passkey, this device stays signed in for 90 days and then signs you out. To get back in after that, you'll need a passkey made later, your recovery code, or a new sign-in link."}
        </p>
      </div>
    </div>
  );
}
