import { type FormEvent, useEffect, useState } from "react";
import { createApi } from "./api.ts";
import { handleHint, inviteTokenFrom, normalizeHandle, suggestHandle } from "./handles.ts";
import {
  defaultPasskeyName,
  passkeyErrorText,
  passkeysSupported,
  signInWithPasskey,
  signUpWithPasskey,
} from "./passkeys.ts";
import { defaultTimeZone } from "./session.ts";

type Choice = "menu" | "signup" | "invite";

/**
 * The first screen when signed out: "Create an account" (only on servers with open sign-up),
 * "I have an invite link", and "Sign in".
 */
export function Start({
  onToken,
  onInvite,
}: {
  onToken(token: string, fresh?: boolean): void;
  onInvite(inviteToken: string): void;
}) {
  const [choice, setChoice] = useState<Choice>("menu");
  const [signupOpen, setSignupOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [devToken, setDevToken] = useState("");
  const supported = passkeysSupported();

  useEffect(() => {
    createApi({ token: null })
      .setupStatus()
      .then(
        (s) => setSignupOpen(s.signup === true),
        () => {},
      );
  }, []);

  const signIn = async () => {
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

  if (choice === "signup") {
    return <SignUp onToken={(t) => onToken(t, true)} onBack={() => setChoice("menu")} />;
  }
  if (choice === "invite") {
    return <PasteInvite onInvite={onInvite} onBack={() => setChoice("menu")} />;
  }

  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Open Lounge Phone</h1>
        {signupOpen && (
          <button
            type="button"
            className="primary"
            disabled={!supported}
            onClick={() => setChoice("signup")}
          >
            Create an account
          </button>
        )}
        <button type="button" onClick={() => setChoice("invite")}>
          I have an invite link
        </button>
        {supported ? (
          <button
            type="button"
            className={signupOpen ? "" : "primary"}
            disabled={busy}
            onClick={() => void signIn()}
          >
            {busy ? "Waiting for your device…" : "Sign in with a passkey"}
          </button>
        ) : (
          <p className="muted">
            Passkeys aren't available here. They need HTTPS (or localhost) and a supported browser.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <p className="muted">
          {signupOpen
            ? "Anyone can create an account on this server. "
            : "This server is invite-only: ask a guardian for an invite link. "}
          Lost your passkey? Ask a guardian for a new sign-in link. Setting up a new server? Open
          the setup link it printed when it first started.
        </p>
        <details>
          <summary>Developer sign-in</summary>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (devToken.trim().length >= 16) onToken(devToken.trim());
            }}
          >
            <label>
              Session token
              <input value={devToken} onChange={(e) => setDevToken(e.target.value)} />
            </label>
            <button type="submit">Sign in</button>
          </form>
        </details>
      </div>
    </div>
  );
}

function PasteInvite({ onInvite, onBack }: { onInvite(token: string): void; onBack(): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = inviteTokenFrom(text);
    if (token) onInvite(token);
    else setError("That doesn't look like an invite link. Paste the whole link you were sent.");
  };
  return (
    <div className="centered">
      <form className="card stack" onSubmit={submit}>
        <h1>I have an invite link</h1>
        <p className="muted">
          Opening the link usually does this for you. If it opened somewhere else, paste it here.
        </p>
        <label>
          Invite link
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://…/#invite=…"
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary">
          Continue
        </button>
        <button type="button" className="link" onClick={onBack}>
          ← Back
        </button>
      </form>
    </div>
  );
}

/** Open sign-up: your name, a handle (your address here), then a passkey. */
function SignUp({ onToken, onBack }: { onToken(token: string): void; onBack(): void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const host = location.host;
  const shown = handleTouched ? handle : suggestHandle(name);
  const hint = shown ? handleHint(shown) : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!shown || hint) {
      setHandleTouched(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const res = await signUpWithPasskey(
        createApi({ token: null }),
        { handle: shown, name: name.trim(), timeZone },
        defaultPasskeyName(navigator.userAgent),
      );
      onToken(res.token);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status ? (err as Error).message : passkeyErrorText(err));
      setBusy(false);
    }
  };

  return (
    <div className="centered">
      <form className="card stack" onSubmit={(e) => void submit(e)}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Create an account</h1>
        <p className="muted">
          You'll get your own household for your phones, and an address people can use to reach you.
          No email or phone number needed: you sign in with a passkey on this device.
        </p>
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jesse"
            maxLength={24}
            autoComplete="given-name"
            required
          />
          <span className="hint">How you appear on phones' keys.</span>
        </label>
        <label>
          Handle
          <input
            value={shown}
            onChange={(e) => {
              setHandleTouched(true);
              setHandle(normalizeHandle(e.target.value));
            }}
            placeholder="jesse"
            maxLength={30}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            aria-describedby="address-preview"
          />
          <span className="hint" id="address-preview">
            {shown && !hint ? (
              <>
                Your address: <strong className="address">{`${shown}@${host}`}</strong>
              </>
            ) : (
              (hint ?? `Your address will be handle@${host}`)
            )}
          </span>
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
          {busy ? "Waiting for your device…" : "Create account with a passkey"}
        </button>
        <button type="button" className="link" onClick={onBack}>
          ← Back
        </button>
      </form>
    </div>
  );
}
