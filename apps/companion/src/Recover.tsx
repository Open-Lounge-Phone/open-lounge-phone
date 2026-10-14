import { type FormEvent, useState } from "react";
import { createApi, errorCode } from "./api.ts";
import { PasskeyHelp } from "./PasskeyHelp.tsx";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  registerPasskey,
} from "./passkeys.ts";
import { ShowRecoveryCode } from "./RecoveryCode.tsx";

type Stage =
  | { name: "form" }
  | { name: "passkey"; token: string; address: string }
  | { name: "code"; token: string; address: string; code: string };

/**
 * "Lost your passkey?" (signed out, also at `/#recover`): your handle and recovery code, then a
 * new passkey on this device, then a new recovery code. The old code is used up.
 */
export function Recover({ onToken, onBack }: { onToken(token: string): void; onBack(): void }) {
  const [stage, setStage] = useState<Stage>({ name: "form" });
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [signOutOthers, setSignOutOthers] = useState(true);
  const supported = passkeysSupported();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await createApi({ token: null }).recover(handle.trim(), code);
      setStage({ name: "passkey", token: res.token, address: res.account.address });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makePasskey = async (token: string, address: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const api = createApi({ token });
      await registerPasskey(api, defaultPasskeyName(navigator.userAgent));
      const fresh = await api.newRecoveryCode();
      setStage({ name: "code", token, address, code: fresh.code });
    } catch (err) {
      setError(
        errorCode(err) === "passkey_required" || (err as { status?: number }).status === 401
          ? "More than 30 minutes went by, so this recovery ended, and the code is used up. If you have no other way in, ask someone who manages your space for a sign-in link."
          : passkeyErrorText(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const finish = async (token: string) => {
    if (signOutOthers) {
      try {
        await createApi({ token }).signOutOthers();
      } catch {
        // Signing out elsewhere can be done later under Account → Where you're signed in.
      }
    }
    onToken(token);
  };

  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        {stage.name === "form" && (
          <form className="stack" onSubmit={(e) => void submit(e)}>
            <h1>Lost your passkey?</h1>
            <p className="muted">
              Enter your handle and the recovery code you saved when you made your account. Then
              you'll make a new passkey on this device.
            </p>
            <label>
              Handle
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="username"
                required
              />
              <span className="hint">Your address without the part after @ works too.</span>
            </label>
            <label>
              Recovery code
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                required
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
            <p className="muted small">
              No recovery code? If this is your only space here, someone who manages it can send you
              a sign-in link.
            </p>
            <button type="button" className="link" onClick={onBack}>
              ← Back
            </button>
          </form>
        )}
        {stage.name === "passkey" && (
          <>
            <h1>Make a new passkey</h1>
            <p>
              Your recovery code worked, and it's now used up. Make a new passkey for{" "}
              <strong className="address">{stage.address}</strong>; you'll get a new recovery code
              right after.
            </p>
            {!supported && (
              <p className="warning">
                This browser can't make passkeys. Open this page on your phone or in another browser
                within 30 minutes, or ask for a sign-in link.
              </p>
            )}
            <PasskeyHelp />
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={busy || !supported}
              onClick={() => void makePasskey(stage.token, stage.address)}
            >
              {busy ? "Waiting for your device…" : "Make a passkey"}
            </button>
          </>
        )}
        {stage.name === "code" && (
          <ShowRecoveryCode
            code={stage.code}
            address={stage.address}
            doneLabel="Done"
            onDone={() => void finish(stage.token)}
          >
            <label className="check">
              <input
                type="checkbox"
                checked={signOutOthers}
                onChange={(e) => setSignOutOthers(e.target.checked)}
              />
              Sign out everywhere else (recommended if a device was lost or someone else might have
              your passkey)
            </label>
          </ShowRecoveryCode>
        )}
      </div>
    </div>
  );
}
