/** The website page that explains passkeys in full. */
export const PASSKEY_HELP_URL = "https://openloungephone.app/how-to/passkeys/";

/**
 * "Why a passkey?": why accounts here use passkeys instead of passwords, and what to do on a
 * device without a fingerprint or face sign-in. Closed until someone opens it.
 */
export function PasskeyHelp({ open = false }: { open?: boolean }) {
  return (
    <details className="passkey-help" open={open}>
      <summary>Why a passkey, and what if my device doesn't have one?</summary>
      <p>
        A passkey replaces a password. You unlock it the way you unlock your device: fingerprint,
        face or screen lock. It's safer than a password because:
      </p>
      <ul>
        <li>There's nothing to remember, reuse or guess.</li>
        <li>
          This server never sees a secret. It keeps only a key that can check you, which is no use
          to anyone who steals it.
        </li>
        <li>It only works on this site, so a fake site can't trick you into handing it over.</li>
        <li>Your fingerprint or face never leaves your device.</li>
      </ul>
      <p>
        <strong>No fingerprint or face sign-in here?</strong> When your browser asks, you can
        choose:
      </p>
      <ul>
        <li>
          <strong>Your phone:</strong> pick "use a phone or tablet" and scan the code with your
          phone's camera. The passkey stays on your phone.
        </li>
        <li>
          <strong>A security key</strong> (a small USB or NFC key such as a YubiKey).
        </li>
        <li>
          <strong>A password manager</strong> that stores passkeys, such as iCloud Keychain, Google
          Password Manager, 1Password, Bitwarden or Proton Pass.
        </li>
        <li>Your computer's own screen lock (Windows Hello, Touch ID or a PIN).</li>
      </ul>
      <p>
        Add a second passkey on another device under <strong>Account</strong>, so losing one device
        doesn't lock you out. <a href={PASSKEY_HELP_URL}>More about passkeys</a>
      </p>
    </details>
  );
}

/** When this browser can't use passkeys at all. */
export function PasskeysUnavailable() {
  return (
    <p className="muted">
      This browser can't use passkeys here. Open this page in a recent Safari, Chrome, Edge or
      Firefox, at an address that starts with https, or open it on your phone.{" "}
      <a href={PASSKEY_HELP_URL}>More about passkeys</a>
    </p>
  );
}
