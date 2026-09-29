// This server's own federation key, and rotating it (docs/federation-spec.md §3.2).
//
// Where the key lives depends on the platform:
// - `env.federationKeys` (self-host): files in DATA_DIR, see apps/server-selfhost/src/adapters.ts.
// - otherwise (Cloudflare, tests): `env.federationKey` is the *root* key (the FED_PRIVATE_KEY
//   secret). Until the first rotation it is also the signing key; a rotation stores the new key in
//   the database (`fed_own_key`), sealed with AES-GCM under a key derived from the root, so the
//   Worker can rotate from the operator view without a redeploy and without holding a Cloudflare
//   API token, and a copy of the database alone reveals nothing.
import type { Account } from "@openloungephone/db";
import {
  type KeyRotation,
  loadServerKey,
  publicKeyOf,
  ROTATION_OVERLAP_S,
  rotationStatement,
  type ServerKey,
  signBytes,
  signRotation,
} from "@openloungephone/federation";
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import type { FederationKeyStore, ServerEnv, StoredFederationKeys } from "./env.ts";

/** Whether this server has a federation key at all (no I/O). */
export const federates = (env: ServerEnv) => !!(env.federationKeys || env.federationKey);

const enc = (s: string) => new TextEncoder().encode(s);

/** The key that seals rotated keys: HKDF-SHA-256 over the root private key's secret bytes. */
async function sealingKey(root: string): Promise<CryptoKey> {
  const d = (JSON.parse(root) as JsonWebKey).d;
  if (!d) throw new Error("the root federation key has no private part");
  const ikm = await crypto.subtle.importKey("raw", fromBase64Url(d), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc("openloungephone-federation-key-seal"),
      info: enc("v1"),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals a private key for the database; the public key is bound as associated data. */
export async function sealKey(root: string, privateKey: string, publicKey: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc(publicKey) },
    await sealingKey(root),
    enc(privateKey),
  );
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), 12);
  return toBase64Url(out);
}

export async function unsealKey(root: string, sealed: string, publicKey: string) {
  const bytes = fromBase64Url(sealed);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: enc(publicKey) },
    await sealingKey(root),
    bytes.slice(12),
  );
  const privateKey = new TextDecoder().decode(pt);
  if (publicKeyOf(privateKey) !== publicKey) throw new Error("sealed key doesn't match its row");
  return privateKey;
}

/** The database-backed store (Cloudflare D1, and the tests' SQLite), rooted in `federationKey`. */
export function dbKeyStore(env: ServerEnv, root: string): FederationKeyStore {
  const conns = env.store.connections;
  return {
    async load() {
      const row = await conns.ownKey();
      if (!row) return { privateKey: root };
      try {
        const privateKey = await unsealKey(root, row.wrappedKey, row.publicKey);
        const r = row.rotation;
        return {
          privateKey,
          ...(r
            ? {
                rotation: {
                  previous_key: r.previousKey,
                  created: r.created,
                  expires: r.expires,
                  sig: r.sig,
                  legacy_sig: r.legacySig,
                },
              }
            : {}),
        };
      } catch (e) {
        // Never fall back to the root key silently: peers pinned the rotated one.
        env.log("error", "federation: can't open the rotated key; is FED_PRIVATE_KEY unchanged?", {
          error: String(e),
        });
        return undefined;
      }
    },
    async save(next, expectPublicKey) {
      const row = await conns.ownKey();
      const current = row ? row.publicKey : publicKeyOf(root);
      if (current !== expectPublicKey) return false;
      const publicKey = publicKeyOf(next.privateKey);
      const r = next.rotation;
      return conns.saveOwnKey(
        {
          publicKey,
          wrappedKey: await sealKey(root, next.privateKey, publicKey),
          rotatedAt: env.now(),
          rotation: r
            ? {
                previousKey: r.previous_key,
                created: r.created,
                expires: r.expires,
                sig: r.sig,
                legacySig: r.legacy_sig,
              }
            : null,
        },
        expectPublicKey,
        !!row,
      );
    },
  };
}

const stores = new WeakMap<ServerEnv, FederationKeyStore>();

export function keyStoreOf(env: ServerEnv): FederationKeyStore | undefined {
  if (env.federationKeys) return env.federationKeys;
  if (!env.federationKey) return undefined;
  let s = stores.get(env);
  if (!s) {
    s = dbKeyStore(env, env.federationKey);
    stores.set(env, s);
  }
  return s;
}

/** Imported keys by their stored form: importing is the costly part, not reading storage. */
const imported = new Map<string, Promise<ServerKey>>();
function importKey(privateKey: string): Promise<ServerKey> {
  let k = imported.get(privateKey);
  if (!k) {
    if (imported.size > 16) imported.clear();
    k = loadServerKey(privateKey);
    imported.set(privateKey, k);
  }
  return k;
}

export interface OwnKeys {
  current: ServerKey;
  /** The hand-over from the previous key, while it's still published. */
  rotation?: KeyRotation & { legacy_sig: string };
}

/**
 * This server's keys, read from storage on every call, so every isolate or Durable Object signs
 * with the current key right after a rotation (there is no cache to go stale).
 */
export async function ownKeys(env: ServerEnv): Promise<OwnKeys | undefined> {
  const stored = await keyStoreOf(env)?.load();
  if (!stored) return undefined;
  const current = await importKey(stored.privateKey);
  const r = stored.rotation;
  const live = r && env.now() < r.expires * 1000;
  return { current, ...(live ? { rotation: r } : {}) };
}

export type RotateResult =
  | { ok: true; previousKey: string; publicKey: string; created: number; expires: number }
  | { ok: false; status: number; error: string; until?: number };

/**
 * Makes a new key, signs the hand-over with the current one (published for
 * `ROTATION_OVERLAP_S`) and signs with the new key from now on. Refused while an earlier
 * rotation is still in its overlap unless `force` (peers that haven't followed the first one
 * yet would then need their operators).
 */
export async function rotateOwnKey(
  env: ServerEnv,
  host: string,
  opts: { force?: boolean; generate: () => Promise<string> },
): Promise<RotateResult> {
  const store = keyStoreOf(env);
  const stored = await store?.load();
  if (!store || !stored) return { ok: false, status: 404, error: "this server doesn't federate" };
  const now = env.now();
  const r = stored.rotation;
  if (r && now < r.expires * 1000 && !opts.force) {
    return {
      ok: false,
      status: 409,
      error: "the last rotation is still in its overlap window",
      until: r.expires * 1000,
    };
  }
  const current = await importKey(stored.privateKey);
  const privateKey = await opts.generate();
  const publicKey = publicKeyOf(privateKey);
  const created = Math.floor(now / 1000);
  const rotation = await signRotation(current, publicKey, host, created, ROTATION_OVERLAP_S);
  const next: StoredFederationKeys = {
    privateKey,
    rotation: { ...rotation, legacy_sig: await signBytes(current, rotationStatement(publicKey)) },
  };
  if (!(await store.save(next, current.publicKey))) {
    return { ok: false, status: 409, error: "the key just changed; look again" };
  }
  return {
    ok: true,
    previousKey: current.publicKey,
    publicKey,
    created,
    expires: rotation.expires,
  };
}

/**
 * Records an operator's action (or, with `actor` null, a key change the server made by itself)
 * in the server-wide audit trail. Never throws: a failed write is logged, not fatal.
 */
export async function operatorAudit(
  env: ServerEnv,
  actor: Account | null,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await env.store.operatorAudit({
      at: env.now(),
      actorAccount: actor?.id ?? null,
      actorName: actor ? `${actor.name} (@${actor.handle})` : "this server",
      action,
      detail: detail ?? null,
    });
  } catch (e) {
    env.log("warn", "operator audit write failed", { action, error: String(e) });
  }
}
