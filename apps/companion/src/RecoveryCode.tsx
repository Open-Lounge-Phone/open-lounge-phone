import { lastRecoveryGroup } from "@openloungephone/core";
import { useEffect, useState } from "react";
import { createApi } from "./api.ts";

/** The text file people save: the code and what it is for. */
export function recoveryFileText(code: string, address: string, host: string): string {
  return [
    "Open Lounge Phone recovery code",
    "",
    `Account: ${address}`,
    `Server:  https://${host}`,
    "",
    `Code:    ${code}`,
    "",
    'Lost your passkey? Open the server\'s page, choose "Lost your passkey?",',
    "and enter your handle and this code. It works once; you then get a new one.",
    "",
    "Keep it private: anyone with your handle and this code can get into your account.",
    "",
  ].join("\n");
}

/**
 * Shows a new recovery code once, with what to do with it, and asks the person to show they
 * saved it (re-typing its last group) before they go on.
 */
export function ShowRecoveryCode({
  code,
  address,
  onDone,
  doneLabel = "Continue",
  children,
}: {
  code: string;
  address: string;
  onDone(): void;
  doneLabel?: string;
  /** Extra choices shown above the button (e.g. "Sign out everywhere else"). */
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [typed, setTyped] = useState("");
  const last = lastRecoveryGroup(code);
  const confirmed = typed.trim().toUpperCase() === last;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const download = () => {
    const blob = new Blob([recoveryFileText(code, address, location.host)], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `open-lounge-phone-recovery-${address.replace(/[^a-z0-9.@-]/gi, "_")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div className="stack">
      <h2>Your recovery code</h2>
      <p>
        If you lose your passkeys, this code gets you back in: choose{" "}
        <strong>Lost your passkey?</strong> on the sign-in screen and enter your handle and this
        code.
      </p>
      <output className="recovery-code" aria-label="Recovery code">
        {code}
      </output>
      <div className="row">
        <button type="button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" onClick={download}>
          Download (.txt)
        </button>
      </div>
      <ul className="bullets small">
        <li>Print it, or keep it in a password manager. This is the only time it's shown.</li>
        <li>Keep it private: anyone with your handle and this code can get into your account.</li>
        <li>It works once. After you use it, you'll make a new passkey and get a new code.</li>
      </ul>
      <label>
        To show you saved it, type its last four characters
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={8}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={typed.length >= 4 && !confirmed ? true : undefined}
        />
        <span className={typed.length >= 4 && !confirmed ? "hint error" : "hint"}>
          {typed.length >= 4 && !confirmed
            ? "That's not how the code ends. Check what you saved."
            : `The last group, after the last dash.`}
        </span>
      </label>
      {children}
      <button type="button" className="primary" disabled={!confirmed} onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}

/**
 * After an account is made (setup link, sign-up, first invite): make its recovery code and show
 * it. If making one fails, the person can go on: the app keeps reminding them until they make
 * one (Account → Recovery code).
 */
export function RecoveryCodeStep({ token, onDone }: { token: string; onDone(): void }) {
  const [code, setCode] = useState<string>();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();
  useEffect(() => {
    const api = createApi({ token });
    api.me().then(
      (me) => setAddress(me.account?.address ?? ""),
      () => {},
    );
    api.newRecoveryCode().then(
      (r) => setCode(r.code),
      (e: Error) => setError(e.message),
    );
  }, [token]);
  return (
    <div className="centered">
      <div className="card stack">
        <img src="/icon.svg" alt="" width={56} height={56} />
        {code ? (
          <ShowRecoveryCode code={code} address={address} onDone={onDone} />
        ) : error ? (
          <>
            <p className="error" role="alert">
              Couldn't make your recovery code: {error}
            </p>
            <p className="muted">You can make one later under Account → Recovery code.</p>
            <button type="button" onClick={onDone}>
              Continue
            </button>
          </>
        ) : (
          <p className="muted">Making your recovery code…</p>
        )}
      </div>
    </div>
  );
}
