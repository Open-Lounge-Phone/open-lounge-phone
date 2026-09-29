import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type { Api, SignedInResult } from "./api.ts";

export const passkeysSupported = (): boolean => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

/** Turns WebAuthn / API failures into something a person can act on. */
export function passkeyErrorText(e: unknown): string {
  const err = e as { name?: string; code?: string; message?: string } | undefined;
  if (err?.code === "ERROR_CEREMONY_ABORTED" || err?.name === "NotAllowedError") {
    return "Cancelled — no passkey was used.";
  }
  if (err?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return "This device already has a passkey for you.";
  }
  if (err?.name === "NotSupportedError" || err?.name === "SecurityError") {
    return "Passkeys aren't available here. They need HTTPS (or localhost) and a supported browser.";
  }
  return err?.message ? `Passkey failed: ${err.message}` : "Passkey failed.";
}

/** A sensible default name for a new passkey, e.g. "iPhone" or "Mac". */
export function defaultPasskeyName(userAgent: string): string {
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android phone";
  if (/Mac OS X|Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  if (/Linux/.test(userAgent)) return "Linux computer";
  return "Passkey";
}

export async function registerPasskey(api: Api, name: string): Promise<void> {
  const { challengeId, options } = await api.passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON: options });
  await api.passkeyRegisterVerify(challengeId, response, name);
}

export async function signInWithPasskey(api: Api): Promise<SignedInResult> {
  const { challengeId, options } = await api.passkeyLoginOptions();
  const response = await startAuthentication({ optionsJSON: options });
  return api.passkeyLoginVerify(challengeId, response);
}

/** Open sign-up: pick a handle, create a passkey, and get an account with its own household. */
export async function signUpWithPasskey(
  api: Api,
  input: { handle: string; name: string; timeZone: string },
  passkeyName: string,
): Promise<SignedInResult> {
  const { challengeId, options } = await api.signupOptions(input);
  const response = await startRegistration({ optionsJSON: options });
  return api.signup(challengeId, response, passkeyName);
}
