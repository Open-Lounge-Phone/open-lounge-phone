import { type FormEvent, useCallback, useEffect, useState } from "react";
import { createApi, errorCode } from "./api.ts";
import { handleHint, inviteTokenFrom, normalizeHandle, suggestHandle } from "./handles.ts";
import { PasskeyHelp, PasskeysUnavailable } from "./PasskeyHelp.tsx";
import {
  defaultPasskeyName,
  devicePasskeyAvailable,
  passkeyErrorText,
  passkeysSupported,
  signInWithPasskey,
  signUpWithPasskey,
} from "./passkeys.ts";
import { Recover } from "./Recover.tsx";
import { defaultTimeZone } from "./session.ts";
import { TimeZonePicker } from "./TimeZonePicker.tsx";
import { Turnstile } from "./Turnstile.tsx";
import { zoneProblem } from "./timeZones.ts";

type Choice = "menu" | "signup" | "invite" | "recover";

/** How a sign-in from the start screen went: a new account, or a passkey from another device. */
export interface StartedHow {
  /** A brand-new account (sign-up): its recovery code comes next. */
  fresh?: boolean;
  /** Signed in with a passkey from another device; this one could make its own. */
  offerPasskey?: boolean;
}

/** The developer sign-in (paste a session token) shows only in dev builds or with `?dev`. */
export const showDevSignIn = (dev: boolean, search: string): boolean =>
  dev || new URLSearchParams(search).has("dev");

/**
 * The first screen when signed out: "Create an account" (only on servers with open sign-up),
 * "I have an invite or sign-in link", "Sign in", and "Lost your passkey?" (also `/#recover`).
 */
export function Start({
  onToken,
  onInvite,
  initial = "menu",
}: {
  onToken(token: string, how?: StartedHow): void;
  onInvite(inviteToken: string): void;
  initial?: "menu" | "recover";
}) {
  const [choice, setChoice] = useState<Choice>(initial);
  // undefined until the server says: never claim "invite-only" (or "open") before we know
  const [signupOpen, setSignupOpen] = useState<boolean>();
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [turnstileKey, setTurnstileKey] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const supported = passkeysSupported();

  useEffect(() => {
    createApi({ token: null })
      .setupStatus()
      .then(
        (s) => {
          setSignupOpen(s.signup === true);
          setSetupNeeded(s.needed === true);
          setTurnstileKey(s.turnstileSiteKey);
        },
        () => setSignupOpen(false),
      );
  }, []);

  const signIn = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await signInWithPasskey(createApi({ token: null }));
      onToken(res.token, {
        offerPasskey: res.crossDevice && (await devicePasskeyAvailable()),
      });
    } catch (e) {
      setError(
        errorCode(e) === "suspended"
          ? "This account is suspended on this server. Its operator can tell you why."
          : passkeyErrorText(e),
      );
      setBusy(false);
    }
  };

  if (choice === "signup") {
    return (
      <SignUp
        turnstileKey={turnstileKey}
        onToken={(t) => onToken(t, { fresh: true })}
        onBack={() => setChoice("menu")}
      />
    );
  }
  if (choice === "recover") {
    return <Recover onToken={(t) => onToken(t)} onBack={() => setChoice("menu")} />;
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
          I have an invite or sign-in link
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
          <PasskeysUnavailable />
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="button" className="link" onClick={() => setChoice("recover")}>
          Lost your passkey?
        </button>
        {supported && <PasskeyHelp />}
        <p className="muted">
          {signupOpen === true && "Anyone can create an account on this server. "}
          {signupOpen === false &&
            "This server is invite-only: ask someone who uses it to invite you. "}
          Lost your passkey? Use your recovery code. If this is your only household or team here,
          someone who manages it can also send you a sign-in link.
          {setupNeeded &&
            " Setting up this server? Open the setup link it printed when it first started."}
        </p>
        {showDevSignIn(import.meta.env.DEV, location.search) && <DevSignIn onToken={onToken} />}
      </div>
    </div>
  );
}

/** Paste a session token (developers; hidden unless this is a dev build or the URL has ?dev). */
function DevSignIn({ onToken }: { onToken(token: string): void }) {
  const [devToken, setDevToken] = useState("");
  const [devProblem, setDevProblem] = useState<string>();
  return (
    <details>
      <summary>Developer sign-in</summary>
      <form
        className="stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const ok = devToken.trim().length >= 16;
          setDevProblem(ok ? undefined : "Paste the whole session token.");
          if (ok) onToken(devToken.trim());
        }}
      >
        <label>
          Session token
          <input
            value={devToken}
            onChange={(e) => {
              setDevToken(e.target.value);
              setDevProblem(undefined);
            }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={devProblem ? true : undefined}
          />
          {devProblem && <span className="hint error">{devProblem}</span>}
        </label>
        <button type="submit">Sign in</button>
      </form>
    </details>
  );
}

function PasteInvite({ onInvite, onBack }: { onInvite(token: string): void; onBack(): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const token = inviteTokenFrom(text);
    if (token) onInvite(token);
    else
      setError(
        "That doesn't look like an invite or sign-in link. Paste the whole link you were sent.",
      );
  };
  return (
    <div className="centered">
      <form className="card stack" onSubmit={submit}>
        <h1>I have an invite or sign-in link</h1>
        <p className="muted">
          Opening the link usually does this for you. If it opened somewhere else, paste it here.
        </p>
        <label>
          Invite or sign-in link
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
function SignUp({
  turnstileKey,
  onToken,
  onBack,
}: {
  /** Set when the server asks for a Turnstile check. */
  turnstileKey?: string | undefined;
  onToken(token: string): void;
  onBack(): void;
}) {
  const [check, setCheck] = useState<string>();
  const [checkFailed, setCheckFailed] = useState(false);
  const [checkTry, setCheckTry] = useState(0);
  /** Bumped after every try: a Turnstile answer works once. */
  const [checkReset, setCheckReset] = useState(0);
  const onCheckToken = useCallback((t: string | undefined) => {
    setCheck(t);
    if (t) setCheckFailed(false);
  }, []);
  const onCheckFail = useCallback(() => setCheckFailed(true), []);
  // a check that never answers (blocked silently) counts as failed after a while
  useEffect(() => {
    if (!turnstileKey || check || checkFailed) return;
    const t = setTimeout(() => setCheckFailed(true), 20_000);
    return () => clearTimeout(t);
  }, [turnstileKey, check, checkFailed]);
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
    if (zoneProblem(timeZone)) return;
    if (turnstileKey && !check) {
      setError(
        checkFailed
          ? "The person check didn't load. Tap Try again below."
          : "One moment: still checking you're a person.",
      );
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const res = await signUpWithPasskey(
        createApi({ token: null }),
        { handle: shown, name: name.trim(), timeZone, ...(check ? { turnstileToken: check } : {}) },
        defaultPasskeyName(navigator.userAgent),
      );
      onToken(res.token);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status ? (err as Error).message : passkeyErrorText(err));
      setBusy(false);
      // The check's answer was used (or the try was refused before it): get a fresh one.
      if (turnstileKey) {
        setCheck(undefined);
        setCheckReset((n) => n + 1);
      }
    }
  };

  return (
    <div className="centered">
      <form className="card stack" onSubmit={(e) => void submit(e)}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>Create an account</h1>
        <p className="muted">
          You'll get your own household for your phones, and an address people can use to reach you.
          No email, phone number or password needed: you sign in with a passkey, the way you unlock
          your device.
        </p>
        <PasskeyHelp />
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
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
        <TimeZonePicker value={timeZone} onChange={setTimeZone} />
        {turnstileKey && (
          <div className="stack">
            <Turnstile
              key={checkTry}
              siteKey={turnstileKey}
              onToken={onCheckToken}
              onFail={onCheckFail}
              reset={checkReset}
            />
            {checkFailed ? (
              <p className="hint error">
                The "are you a person?" check didn't load. A content blocker can stop it.{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setCheckFailed(false);
                    setCheckTry((n) => n + 1);
                  }}
                >
                  Try again
                </button>
              </p>
            ) : (
              !check && <p className="hint">Checking you're a person…</p>
            )}
          </div>
        )}
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
