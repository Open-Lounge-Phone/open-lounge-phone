import { toBase64Url } from "@opentincan/protocol";

/**
 * The emulated phone's identity: an Ed25519 keypair whose private key never leaves WebCrypto
 * (stored as a non-extractable CryptoKey in IndexedDB), plus the deviceId assigned at pairing.
 * `profile` namespaces storage so several phones can run in one browser.
 */
export interface Identity {
  privateKey: CryptoKey;
  /** Raw 32-byte public key, base64url. */
  publicKey: string;
}

const STORE = "keys";
const KEY = "ed25519";

function openDb(profile: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`opentincan-device:${profile}`, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadOrCreateIdentity(profile: string): Promise<Identity> {
  const db = await openDb(profile);
  try {
    const existing = await request<Identity | undefined>(
      db.transaction(STORE).objectStore(STORE).get(KEY),
    );
    if (existing) return existing;
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const identity: Identity = { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).put(identity, KEY));
    return identity;
  } finally {
    db.close();
  }
}

export async function forgetIdentity(profile: string): Promise<void> {
  const db = await openDb(profile);
  try {
    await request(db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY));
  } finally {
    db.close();
  }
  setDeviceId(profile, undefined);
}

export async function sign(identity: Identity, message: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", identity.privateKey, message)),
  );
}

const idKey = (profile: string) => `opentincan:${profile}:deviceId`;

export function getDeviceId(profile: string): string | undefined {
  try {
    return localStorage.getItem(idKey(profile)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setDeviceId(profile: string, id: string | undefined): void {
  try {
    if (id) localStorage.setItem(idKey(profile), id);
    else localStorage.removeItem(idKey(profile));
  } catch {
    // Storage blocked: the phone will simply re-pair next time.
  }
}
