import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import { type Api, ApiError, type SignedInResult } from "./api.ts";

export const passkeysSupported = (): boolean => {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
};

/** This device can make a passkey of its own (fingerprint, face or screen lock). */
export async function devicePasskeyAvailable(): Promise<boolean> {
  try {
    return passkeysSupported() && (await platformAuthenticatorIsAvailable());
  } catch {
    return false;
  }
}

/** Thrown when this page's address isn't the one the server's passkeys belong to. */
export class AddressMismatch extends Error {
  readonly rpId: string;
  constructor(rpId: string) {
    super(`this server's address doesn't match (${rpId})`);
    this.name = "AddressMismatch";
    this.rpId = rpId;
  }
}

/**
 * Whether passkeys made for `rpId` can be used on a page at `hostname` (the same name, or a
 * name under it). When not, the browser refuses with a vague SecurityError.
 */
export function addressMatches(rpId: string | undefined, hostname: string): boolean {
  if (!rpId) return true;
  const host = hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  return host === rp || host.endsWith(`.${rp}`);
}

/** Turns WebAuthn / API failures into something a person can act on. */
export function passkeyErrorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof AddressMismatch) {
    return `This server's address doesn't match the one its passkeys belong to. Open it at https://${e.rpId} instead.`;
  }
  const err = e as { name?: string; code?: string; message?: string } | undefined;
  if (err?.code === "ERROR_CEREMONY_ABORTED" || err?.name === "NotAllowedError") {
    return "No passkey was used. If this device can't make one, try again and choose your phone, a security key or a password manager in the window that opens.";
  }
  if (err?.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
    return "This device already has a passkey for you.";
  }
  if (err?.name === "NotSupportedError" || err?.name === "SecurityError") {
    return "This browser can't use passkeys here. Try a recent Safari, Chrome, Edge or Firefox at an https address, or your phone.";
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

/** The relying-party id in registration or sign-in options (`rp.id` or `rpId`). */
function rpIdOf(options: { rp?: { id?: string }; rpId?: string }): string | undefined {
  return options.rp?.id ?? options.rpId;
}

function checkAddress(options: { rp?: { id?: string }; rpId?: string }): void {
  const rpId = rpIdOf(options);
  if (!addressMatches(rpId, location.hostname)) throw new AddressMismatch(rpId as string);
}

export async function registerPasskey(api: Api, name: string): Promise<void> {
  const { challengeId, options } = await api.passkeyRegisterOptions();
  checkAddress(options);
  const response = await startRegistration({ optionsJSON: options });
  await api.passkeyRegisterVerify(challengeId, response, name);
}

/**
 * Tells the browser (or password manager) that a passkey it offered is no longer an account
 * here, so it can stop offering it. Only where supported.
 */
function forgetPasskey(rpId: string | undefined, credentialId: string): void {
  const pkc = (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential as
    | { signalUnknownCredential?(o: { rpId: string; credentialId: string }): Promise<void> }
    | undefined;
  if (!rpId || typeof pkc?.signalUnknownCredential !== "function") return;
  pkc.signalUnknownCredential({ rpId, credentialId }).catch(() => {});
}

/** Signed in with a passkey; `crossDevice` when it came from another device (a phone by QR). */
export async function signInWithPasskey(
  api: Api,
): Promise<SignedInResult & { crossDevice: boolean }> {
  const { challengeId, options } = await api.passkeyLoginOptions();
  checkAddress(options);
  const response = await startAuthentication({ optionsJSON: options });
  try {
    const res = await api.passkeyLoginVerify(challengeId, response);
    return { ...res, crossDevice: response.authenticatorAttachment === "cross-platform" };
  } catch (e) {
    if (e instanceof ApiError && e.code === "unknown_passkey") {
      forgetPasskey(rpIdOf(options), response.id);
    }
    throw e;
  }
}

/** Open sign-up: pick a handle, create a passkey, and get an account with its own household. */
export async function signUpWithPasskey(
  api: Api,
  input: { handle: string; name: string; timeZone: string; turnstileToken?: string },
  passkeyName: string,
): Promise<SignedInResult> {
  const { challengeId, options } = await api.signupOptions(input);
  checkAddress(options);
  const response = await startRegistration({ optionsJSON: options });
  return api.signup(challengeId, response, passkeyName);
}
