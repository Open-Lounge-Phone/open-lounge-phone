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

  /** Removes an add-on; its shares, grants and requests go with it. */
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

  /** Its owner saw (and dismissed) the note that the old allow-list was removed (0031). */
  async dismissAllowNote(id: string): Promise<void> {
    await this.sql.run("UPDATE addons SET allow_note = 0 WHERE id = ?", id);
  }

  /** Whether its owner still has to see that note. */
  async allowNote(id: string): Promise<boolean> {
    const r = await this.sql.first<{ allow_note: number }>(
      "SELECT allow_note FROM addons WHERE id = ?",
      id,
    );
    return r?.allow_note === 1;
  }

  // --- shares (docs/add-ons.md, Sharing) ----------------------------------------------------

  /** What it offers for sharing, in its order. */
  async shares(addonId: string): Promise<AddonShare[]> {
    return this.sql.all<AddonShare>(
      "SELECT share_id AS id, label FROM addon_shares WHERE addon_id = ? ORDER BY position",
      addonId,
    );
  }

  async share(addonId: string, shareId: string): Promise<AddonShare | undefined> {
    return this.sql.first<AddonShare>(
      "SELECT share_id AS id, label FROM addon_shares WHERE addon_id = ? AND share_id = ?",
      addonId,
      shareId,
    );
  }

  /**
   * Replaces what it offers (`addon.shares`). Shares it kept keep their grants (a new label is
   * taken); shares it dropped go, and so do their grants. Answers the shares that went, and the
   * grants that went with them.
   */
  async setShares(
    addonId: string,
    shares: AddonShare[],
  ): Promise<{ removed: string[]; revoked: AddonGrant[] }> {
    const seen = new Set<string>();
    const next = shares.filter((x) => !seen.has(x.id) && seen.add(x.id));
    const before = await this.shares(addonId);
    const removed = before.filter((b) => !seen.has(b.id)).map((b) => b.id);
    const revoked = (await this.grants(addonId)).filter((g) => removed.includes(g.shareId));
    await this.sql.batch([
      ...removed.flatMap((id) => [
        {
          query: "DELETE FROM addon_grants WHERE addon_id = ? AND share_id = ?",
          params: [addonId, id],
        },
        {
          query: "DELETE FROM addon_shares WHERE addon_id = ? AND share_id = ?",
          params: [addonId, id],
        },
      ]),
      ...next.map((x, i) => ({
        query: `INSERT INTO addon_shares (addon_id, share_id, label, position) VALUES (?, ?, ?, ?)
          ON CONFLICT (addon_id, share_id) DO UPDATE SET label = excluded.label,
          position = excluded.position`,
        params: [addonId, x.id, x.label, i],
      })),
    ]);
    return { removed, revoked };
  }

  /** Every grant of an add-on's shares, oldest first. */
  async grants(addonId: string): Promise<AddonGrant[]> {
    const rows = await this.sql.all<GrantRow>(
      "SELECT * FROM addon_grants WHERE addon_id = ? ORDER BY created_at, id",
      addonId,
    );
    return rows.map(toGrant);
  }

  async getGrant(id: string): Promise<AddonGrant | undefined> {
    const r = await this.sql.first<GrantRow>("SELECT * FROM addon_grants WHERE id = ?", id);
    return r && toGrant(r);
  }

  /** The grant someone holds for one share (by their server and stable account id there). */
  async grantFor(
    addonId: string,
    shareId: string,
    host: string,
    accountId: string,
  ): Promise<AddonGrant | undefined> {
    const r = await this.sql.first<GrantRow>(
      `SELECT * FROM addon_grants WHERE addon_id = ? AND share_id = ? AND host = ?
       AND account_id = ?`,
      addonId,
      shareId,
      host,
      accountId,
    );
    return r && toGrant(r);
  }

  /**
   * Gives a share to someone (only a share the add-on offers now). Giving it again keeps the
   * first grant. Answers the grant, or undefined when there is no such share.
   */
  async grant(
    addonId: string,
    shareId: string,
    holder: ShareHolder,
    now: number,
  ): Promise<AddonGrant | undefined> {
    if (!(await this.share(addonId, shareId))) return undefined;
    const id = newId("ag");
    await this.sql.run(
      `INSERT INTO addon_grants (id, addon_id, share_id, host, account_id, handle, name,
         connection_id, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
         (SELECT 1 FROM addon_shares WHERE addon_id = ? AND share_id = ?)
       ON CONFLICT (addon_id, share_id, host, account_id) DO NOTHING`,
      id,
      addonId,
      shareId,
      holder.host,
      holder.accountId,
      holder.handle,
      holder.name,
      holder.connectionId,
      now,
      addonId,
      shareId,
    );
    return this.grantFor(addonId, shareId, holder.host, holder.accountId);
  }

  /** Takes a grant back; answers whether it existed. */
  async revoke(grantId: string): Promise<boolean> {
    const { changes } = await this.sql.run("DELETE FROM addon_grants WHERE id = ?", grantId);
    return changes === 1;
  }

  /**
   * What someone on this server holds (`host` ''): every share of anyone's add-on given to this
   * account, with the add-on and its owner.
   */
  async heldBy(accountId: string): Promise<HeldShare[]> {
    const rows = await this.sql.all<
      GrantRow & {
        label: string;
        addon_name: string;
        owner_account: string;
        owner_handle: string;
        owner_name: string;
      }
    >(
      `SELECT g.*, s.label, a.name AS addon_name, a.account_id AS owner_account,
         o.handle AS owner_handle,
         o.name AS owner_name
       FROM addon_grants g
       JOIN addon_shares s ON s.addon_id = g.addon_id AND s.share_id = g.share_id
       JOIN addons a ON a.id = g.addon_id
       JOIN accounts o ON o.id = a.account_id
       WHERE g.host = '' AND g.account_id = ?
       ORDER BY o.name, a.name, s.position`,
      accountId,
    );
    return rows.map((r) => ({
      ...toGrant(r),
      label: r.label,
      addonName: r.addon_name,
      ownerAccountId: r.owner_account,
      ownerHandle: r.owner_handle,
      ownerName: r.owner_name,
    }));
  }

  /**
   * The shares of an account's add-ons given to the person on the other side of one of its
   * connections (what `/fed/v1/addon-shares` tells their server).
   */
  async givenTo(
    ownerAccountId: string,
    host: string,
    accountId: string,
  ): Promise<{ addon: string; share: string; label: string }[]> {
    return this.sql.all(
      `SELECT a.name AS addon, s.share_id AS share, s.label
       FROM addon_grants g
       JOIN addon_shares s ON s.addon_id = g.addon_id AND s.share_id = g.share_id
       JOIN addons a ON a.id = g.addon_id
       WHERE a.account_id = ? AND g.host = ? AND g.account_id = ?
       ORDER BY a.name, s.position`,
      ownerAccountId,
      host,
      accountId,
    );
  }

  // --- shares other servers' people gave us (`/fed/v1/addon-shares`) -----------------------

  /** Replaces the shares of add-ons on the other side of a connection that we hold. */
  async setReceived(
    connectionId: string,
    shares: { addon: string; share: string; label: string }[],
  ): Promise<void> {
    await this.sql.batch([
      {
        query: "DELETE FROM connection_addon_shares WHERE connection_id = ?",
        params: [connectionId],
      },
      ...shares.map((x) => ({
        query: `INSERT OR REPLACE INTO connection_addon_shares (connection_id, addon, share_id,
          label) VALUES (?, ?, ?, ?)`,
        params: [connectionId, x.addon, x.share, x.label],
      })),
    ]);
  }

  async received(connectionId: string): Promise<{ addon: string; share: string; label: string }[]> {
    return this.sql.all(
      `SELECT addon, share_id AS share, label FROM connection_addon_shares
       WHERE connection_id = ? ORDER BY addon, label`,
      connectionId,
    );
  }

  // --- "New shared project with…" -----------------------------------------------------------

  async createRequest(
    input: { addonId: string; label: string; holders: ShareHolder[]; state: ShareRequestState },
    now: number,
  ): Promise<ShareRequest> {
    const id = newId("sr");
    await this.sql.run(
      `INSERT INTO addon_share_requests (id, addon_id, label, holders, state, created_at,
         answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.addonId,
      input.label,
      JSON.stringify(input.holders),
      input.state,
      now,
      input.state === "waiting" ? null : now,
    );
    return (await this.getRequest(id)) as ShareRequest;
  }

  async getRequest(id: string): Promise<ShareRequest | undefined> {
    const r = await this.sql.first<RequestRow>(
      "SELECT * FROM addon_share_requests WHERE id = ?",
      id,
    );
    return r && toRequest(r);
  }

  /**
   * Settles a waiting request (once: answers false if it was already settled, e.g. it timed
   * out or the add-on answered twice).
   */
  async settleRequest(
    id: string,
    outcome: { state: Exclude<ShareRequestState, "waiting">; shareId?: string; reason?: string },
    now: number,
  ): Promise<boolean> {
    const { changes } = await this.sql.run(
      `UPDATE addon_share_requests SET state = ?, share_id = ?, reason = ?, answered_at = ?
       WHERE id = ? AND state = 'waiting'`,
      outcome.state,
      outcome.shareId ?? null,
      outcome.reason ?? null,
      now,
      id,
    );
    return changes === 1;
  }
}

/** Something an add-on offers for sharing (`addon.shares`). */
export interface AddonShare {
  id: string;
  label: string;
}

/** Someone a share is given to: here (`host` '') or on another server, by stable account id. */
export interface ShareHolder {
  host: string;
  accountId: string;
  /** As of granting (shown to the owner; calls match `accountId`). */
  handle: string;
  name: string;
  /** Given through this connection of the owner's (always, for another server). */
  connectionId: string | null;
}

export interface AddonGrant extends ShareHolder {
  id: string;
  addonId: string;
  shareId: string;
  createdAt: number;
}

/** A share someone here holds, with whose add-on it is. */
export interface HeldShare extends AddonGrant {
  label: string;
  addonName: string;
  ownerAccountId: string;
  ownerHandle: string;
  ownerName: string;
}

export type ShareRequestState = "waiting" | "created" | "refused" | "offline" | "timeout";

export interface ShareRequest {
  id: string;
  addonId: string;
  label: string;
  holders: ShareHolder[];
  state: ShareRequestState;
  shareId: string | null;
  reason: string | null;
  createdAt: number;
  answeredAt: number | null;
}

type GrantRow = {
  id: string;
  addon_id: string;
  share_id: string;
  host: string;
  account_id: string;
  handle: string;
  name: string;
  connection_id: string | null;
  created_at: number;
};

const toGrant = (r: GrantRow): AddonGrant => ({
  id: r.id,
  addonId: r.addon_id,
  shareId: r.share_id,
  host: r.host,
  accountId: r.account_id,
  handle: r.handle,
  name: r.name,
  connectionId: r.connection_id,
  createdAt: r.created_at,
});

type RequestRow = {
  id: string;
  addon_id: string;
  label: string;
  holders: string;
  state: ShareRequestState;
  share_id: string | null;
  reason: string | null;
  created_at: number;
  answered_at: number | null;
};

const toRequest = (r: RequestRow): ShareRequest => {
  let holders: ShareHolder[] = [];
  try {
    const parsed = JSON.parse(r.holders);
    if (Array.isArray(parsed)) holders = parsed as ShareHolder[];
  } catch {
    // An unreadable list gives nobody anything.
  }
  return {
    id: r.id,
    addonId: r.addon_id,
    label: r.label,
    holders,
    state: r.state,
    shareId: r.share_id,
    reason: r.reason,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
};
