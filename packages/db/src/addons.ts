import { newId } from "./crypto.ts";
import type { Sql } from "./sql.ts";

/** An add-on linked to a person's account (see migration 0028, docs/add-ons.md). */
export interface Addon {
  id: string;
  accountId: string;
  /** The space it was linked in, and the owner's membership there. */
  householdId: string;
  userId: string;
  /** The part after `+` in `handle+name@host`. */
  name: string;
  publicKey: string;
  keyAlg: "ed25519" | "p256";
  createdAt: number;
  lastSeen: number | null;
  fw: string | null;
}

type Row = {
  id: string;
  account_id: string;
  household_id: string;
  user_id: string;
  name: string;
  public_key: string;
  key_alg: "ed25519" | "p256";
  created_at: number;
  last_seen: number | null;
  fw: string | null;
};

const toAddon = (r: Row): Addon => ({
  id: r.id,
  accountId: r.account_id,
  householdId: r.household_id,
  userId: r.user_id,
  name: r.name,
  publicKey: r.public_key,
  keyAlg: r.key_alg,
  createdAt: r.created_at,
  lastSeen: r.last_seen,
  fw: r.fw,
});

/** Why linking an add-on didn't happen. */
export type LinkRefusal = "no_code" | "name_taken";

export class AddonStore {
  private readonly sql: Sql;

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async get(id: string): Promise<Addon | undefined> {
    const r = await this.sql.first<Row>("SELECT * FROM addons WHERE id = ?", id);
    return r && toAddon(r);
  }

  /** The add-on `name` on the account with this handle (`handle+name@host` on this server). */
  async byAddress(handle: string, name: string): Promise<Addon | undefined> {
    const r = await this.sql.first<Row>(
      `SELECT addons.* FROM addons JOIN accounts ON accounts.id = addons.account_id
       WHERE accounts.handle = ? AND addons.name = ?`,
      handle.toLowerCase(),
      name.toLowerCase(),
    );
    return r && toAddon(r);
  }

  /** An account's add-ons, by name. */
  async list(accountId: string): Promise<Addon[]> {
    const rows = await this.sql.all<Row>(
      "SELECT * FROM addons WHERE account_id = ? ORDER BY name",
      accountId,
    );
    return rows.map(toAddon);
  }

  /**
   * Claims an add-on's pairing code for an account (single use): only a code an add-on asked
   * for (`pair.begin` `kind: "addon"`), never a phone's. The name must be free on the account.
   */
  async link(
    input: { code: string; accountId: string; householdId: string; userId: string; name: string },
    now: number,
  ): Promise<Addon | LinkRefusal> {
    const pending = await this.sql.first<{ public_key: string; key_alg: Addon["keyAlg"] }>(
      "SELECT public_key, key_alg FROM pairings WHERE code = ? AND expires_at > ? AND kind = 'addon'",
      input.code,
      now,
    );
    if (!pending) return "no_code";
    const name = input.name.toLowerCase();
    const taken = await this.sql.first<{ id: string }>(
      "SELECT id FROM addons WHERE account_id = ? AND name = ? AND public_key != ?",
      input.accountId,
      name,
      pending.public_key,
    );
    if (taken) return "name_taken";
    const { changes } = await this.sql.run("DELETE FROM pairings WHERE code = ?", input.code);
    if (changes !== 1) return "no_code"; // claimed concurrently
    const addon: Addon = {
      id: newId("ao"),
      accountId: input.accountId,
      householdId: input.householdId,
      userId: input.userId,
      name,
      publicKey: pending.public_key,
      keyAlg: pending.key_alg,
      createdAt: now,
      lastSeen: null,
      fw: null,
    };
    // A key linked again replaces its earlier link (and is never also a phone).
    await this.sql.batch([
      { query: "DELETE FROM addons WHERE public_key = ?", params: [addon.publicKey] },
      { query: "DELETE FROM devices WHERE public_key = ?", params: [addon.publicKey] },
      {
        query: `INSERT INTO addons (id, account_id, household_id, user_id, name, public_key,
          key_alg, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          addon.id,
          addon.accountId,
          addon.householdId,
          addon.userId,
          addon.name,
          addon.publicKey,
          addon.keyAlg,
          now,
        ],
      },
    ]);
    return addon;
  }

  /** Removes an add-on; its allow-list goes with it. */
  async delete(id: string): Promise<void> {
    await this.sql.run("DELETE FROM addons WHERE id = ?", id);
  }

  /** It connected: when, and what it runs. */
  async touch(id: string, now: number, fw?: string): Promise<void> {
    await this.sql.run(
      "UPDATE addons SET last_seen = ?, fw = COALESCE(?, fw) WHERE id = ?",
      now,
      fw ?? null,
      id,
    );
  }

  /** The connections (ids) allowed to talk to it besides its owner. */
  async allowed(addonId: string): Promise<string[]> {
    const rows = await this.sql.all<{ connection_id: string }>(
      "SELECT connection_id FROM addon_allow WHERE addon_id = ? ORDER BY connection_id",
      addonId,
    );
    return rows.map((r) => r.connection_id);
  }

  async isAllowed(addonId: string, connectionId: string): Promise<boolean> {
    return !!(await this.sql.first(
      "SELECT 1 AS x FROM addon_allow WHERE addon_id = ? AND connection_id = ?",
      addonId,
      connectionId,
    ));
  }

  /**
   * Replaces who may talk to it. Only the owner's own connections are kept (the caller checks
   * they're active); anything else is dropped.
   */
  async setAllowed(addonId: string, connectionIds: string[]): Promise<void> {
    const addon = await this.get(addonId);
    if (!addon) return;
    const unique = [...new Set(connectionIds)];
    await this.sql.batch([
      { query: "DELETE FROM addon_allow WHERE addon_id = ?", params: [addonId] },
      ...unique.map((c) => ({
        query: `INSERT INTO addon_allow (addon_id, connection_id)
          SELECT ?, id FROM connections WHERE id = ? AND account_id = ?`,
        params: [addonId, c, addon.accountId],
      })),
    ]);
  }
}
