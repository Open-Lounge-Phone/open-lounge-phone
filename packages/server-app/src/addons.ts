// Add-ons (docs/add-ons.md): services a person links to their own account. An add-on connects
// like a phone (pairing code, then a signed challenge on every connection) and is called at
// `handle+name@host`. Default deny: only its owner talks to it at that address (either way). The
// add-on itself defines what can be shared (its shares, `addon.shares`); its owner gives a share
// to people, and only they reach it, at the share's own address `handle+name+share@host`. Nobody
// can knock on an add-on, it is in no directory, and kids' phones never reach one. The whole
// feature is off unless the server's operator turns it on (`ADDONS=on`).
import {
  type Account,
  type Addon,
  type AddonGrant,
  LOCAL_HOST,
  type ShareHolder,
  type ShareRequest,
} from "@openloungephone/db";
import { ADDON_NAME_RE } from "@openloungephone/federation";
import type { ServerToApp, ServerToDevice } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import { fedFetch, ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { federates } from "./ownKey.ts";
import { peerSupports, UNAVAILABLE } from "./peers.ts";

/** What linking says when the server's operator hasn't turned add-ons on. */
export const ADDONS_OFF = "This server doesn't offer add-ons. Its operator can turn them on.";
/** A phone's pairing screen, given an add-on's code. */
export const ADDON_CODE = "That code is for an add-on: link it under Settings → Add-ons.";
/** The add-ons screen, given a phone's code. */
export const PHONE_CODE = "That code is for a phone: add it under Phones.";
/** How many add-ons one account may link. */
export const MAX_ADDONS_PER_ACCOUNT = 10;
/** How long the owner's "New shared project with…" waits for the add-on's answer. */
export const SHARE_REQUEST_MS = 60_000;
/** How many people one share may be given to. */
export const MAX_HOLDERS_PER_SHARE = 50;

/** `handle+name@host`. */
export const addonAddress = (env: ServerEnv, handle: string, name: string) =>
  `${handle}+${name}@${ownHost(env)}`;

/** `handle+name+share@host`: one share of an add-on. */
export const shareAddress = (env: ServerEnv, handle: string, name: string, share: string) =>
  `${handle}+${name}+${share}@${ownHost(env)}`;

/** A person, by their server ('' = this one) and their stable account there. */
export interface Who {
  host: string;
  accountId: string;
  handle: string;
}

/** How a call reaches an add-on: as its owner (no `share`), or through a share someone holds. */
export interface AddonAccess {
  share?: { id: string; label: string; grantId: string };
}

/**
 * Whether someone may talk to `addon`, and as what. Without `shareId` (the plain address): only
 * its owner, an account on this server. With `shareId`: only someone holding a grant for that
 * share, while the share is offered and they're still the owner's connection (or, here, share a
 * space with the owner). Everything else is refused, and so is everything while add-ons are off
 * or the owner's account is suspended.
 */
export async function addonAccess(
  env: ServerEnv,
  addon: Addon,
  who: Who,
  shareId?: string,
): Promise<AddonAccess | undefined> {
  if (!env.addons) return undefined;
  const { store } = env;
  const owner = await store.getAccount(addon.accountId);
  if (!owner || owner.suspendedAt !== null) return undefined;
  if (shareId === undefined) {
    return who.host === LOCAL_HOST && who.accountId === addon.accountId ? {} : undefined;
  }
  const share = await store.addons.share(addon.id, shareId);
  if (!share) return undefined;
  const grant = await store.addons.grantFor(addon.id, shareId, who.host, who.accountId);
  if (!grant || !(await stillReachable(env, addon.accountId, who))) return undefined;
  return { share: { id: share.id, label: share.label, grantId: grant.id } };
}

/**
 * A holder still counts: not blocked by the owner, and the owner's active connection, or (on this
 * server) in one of the owner's spaces.
 */
async function stillReachable(env: ServerEnv, ownerAccountId: string, who: Who): Promise<boolean> {
  const { store } = env;
  if (who.host === LOCAL_HOST && who.accountId === ownerAccountId) return false;
  const peer = { id: who.accountId, handle: who.handle };
  if (await store.connections.blocked(ownerAccountId, who.host, peer)) return false;
  const conn = await store.connections.findPeer(ownerAccountId, who.host, peer);
  if (conn?.state === "active" && conn.peerAccount === who.accountId) return true;
  if (who.host !== LOCAL_HOST) return false;
  const mine = new Set((await store.listMemberships(ownerAccountId)).map((m) => m.household.id));
  return (await store.listMemberships(who.accountId)).some((m) => mine.has(m.household.id));
}

const partyOf = (a: Account) => ({ handle: a.handle, id: a.id, name: a.name });

/** A holder's address as their owner sees it (`handle@host`). */
export const holderAddress = (env: ServerEnv, h: { host: string; handle: string }) =>
  `${h.handle}@${h.host || ownHost(env)}`;

/**
 * Tells a holder's side what they hold of the owner's add-ons now: their apps here reload
 * (`connections.changed`), or their server gets the whole list (`/fed/v1/addon-shares`, only if
 * it lists `addon-shares`). Never throws.
 */
export async function tellHolder(
  env: ServerEnv,
  notify: ((accountId: string, msg: ServerToApp) => Promise<void>) | undefined,
  ownerAccountId: string,
  holder: Pick<ShareHolder, "host" | "accountId" | "handle" | "connectionId">,
): Promise<void> {
  const { store } = env;
  try {
    if (holder.host === LOCAL_HOST) {
      await notify?.(holder.accountId, { t: "connections.changed" });
      return;
    }
    const conn = holder.connectionId
      ? await store.connections.get(holder.connectionId)
      : await store.connections.findPeer(ownerAccountId, holder.host, {
          id: holder.accountId,
          handle: holder.handle,
        });
    if (conn?.state !== "active" || conn.peerAccount !== holder.accountId) return;
    if (!(await peerSupports(env, holder.host, "addon-shares"))) return;
    const owner = await store.getAccount(ownerAccountId);
    if (!owner) return;
    const shares = await store.addons.givenTo(ownerAccountId, holder.host, holder.accountId);
    await fedFetch(env, holder.host, "/addon-shares", {
      json: { from: partyOf(owner), to: conn.peerHandle, shares },
    });
  } catch (e) {
    env.log("warn", "add-on shares: holder not told", { host: holder.host, error: String(e) });
  }
}

/** Audited in the space the add-on was linked in, as its owner there. */
export async function auditAddon(
  env: ServerEnv,
  addon: Addon,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const [user, account] = await Promise.all([
    env.store.getUser(addon.userId),
    env.store.getAccount(addon.accountId),
  ]);
  if (user && account) {
    await audit(env, { user, account }, action, {
      addonId: addon.id,
      name: addon.name,
      ...detail,
    });
  }
}

/**
 * Gives a share to people (after the owner chose them, or the add-on made the share they asked
 * for), tells their side and audits each grant. Answers the grants made.
 */
export async function giveShare(
  env: ServerEnv,
  notify: ((accountId: string, msg: ServerToApp) => Promise<void>) | undefined,
  addon: Addon,
  shareId: string,
  holders: ShareHolder[],
): Promise<AddonGrant[]> {
  const out: AddonGrant[] = [];
  const share = await env.store.addons.share(addon.id, shareId);
  if (!share) return out;
  for (const h of holders) {
    const held = (await env.store.addons.grants(addon.id)).filter((g) => g.shareId === shareId);
    if (held.length >= MAX_HOLDERS_PER_SHARE) break;
    const grant = await env.store.addons.grant(addon.id, shareId, h, env.now());
    if (!grant) continue;
    out.push(grant);
    await tellHolder(env, notify, addon.accountId, h);
    await auditAddon(env, addon, "addon.grant", {
      share: share.id,
      label: share.label,
      grantId: grant.id,
      to: holderAddress(env, h),
    });
  }
  return out;
}

/** A share request as the owner's app sees it, timing it out once its time is up. */
export async function requestView(env: ServerEnv, addon: Addon, req: ShareRequest) {
  let r = req;
  if (r.state === "waiting" && env.now() - r.createdAt >= SHARE_REQUEST_MS) {
    if (await env.store.addons.settleRequest(r.id, { state: "timeout" }, env.now())) {
      await auditAddon(env, addon, "addon.share.timeout", { requestId: r.id, label: r.label });
    }
    r = (await env.store.addons.getRequest(r.id)) ?? r;
  }
  return {
    id: r.id,
    label: r.label,
    state: r.state,
    ...(r.shareId ? { shareId: r.shareId } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
    people: r.holders.map((h) => h.name),
    createdAt: r.createdAt,
  };
}

/**
 * The add-on answered a share request (`addon.share.created` / `addon.share.refused`), on its
 * socket. Created: the share must be one it offers now (it sends `addon.shares` first); the
 * people in the request then get it. Answers an error for the add-on, if any.
 */
export async function answerShareRequest(
  env: ServerEnv,
  notify: ((accountId: string, msg: ServerToApp) => Promise<void>) | undefined,
  addon: Addon,
  answer: { requestId: string } & ({ id: string } | { reason: string }),
): Promise<string | undefined> {
  const { store } = env;
  const req = await store.addons.getRequest(answer.requestId);
  if (req?.addonId !== addon.id) return "no such request";
  if (req.state !== "waiting") return "that request isn't waiting any more";
  if (env.now() - req.createdAt >= SHARE_REQUEST_MS) {
    await requestView(env, addon, req);
    return "that request timed out";
  }
  if ("reason" in answer) {
    if (
      await store.addons.settleRequest(
        req.id,
        { state: "refused", reason: answer.reason },
        env.now(),
      )
    ) {
      await auditAddon(env, addon, "addon.share.refused", { requestId: req.id, label: req.label });
    }
    return undefined;
  }
  const share = await store.addons.share(addon.id, answer.id);
  if (!share) return "send addon.shares with the new share first";
  if (
    !(await store.addons.settleRequest(req.id, { state: "created", shareId: share.id }, env.now()))
  ) {
    return "that request isn't waiting any more";
  }
  await auditAddon(env, addon, "addon.share.created", {
    requestId: req.id,
    share: share.id,
    label: share.label,
    people: req.holders.length,
  });
  await giveShare(env, notify, addon, share.id, req.holders);
  return undefined;
}

const Name = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ADDON_NAME_RE, "Use 2 to 30 letters, digits, dots, dashes or underscores.");
const LinkBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: Name,
  // Older apps still send who may talk to it; sharing is per share now, so it's ignored.
  allow: z.array(z.string().max(64)).max(200).optional(),
});
/** Someone to give a share to: one of your connections, or a member of one of your spaces. */
const PersonRef = z.string().regex(/^(conn|user):[A-Za-z0-9_-]{1,64}$/);
const GrantBody = z.object({ to: PersonRef });
const RequestBody = z.object({
  label: z.string().trim().min(1, "Give it a name.").max(40),
  with: z.array(PersonRef).max(MAX_HOLDERS_PER_SHARE),
});

/** Settings → Add-ons: link (with the add-on's code), list, shares and who holds them, remove. */
export function addonRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;
  const notify = (accountId: string, msg: ServerToApp) => live.notifyAccount(accountId, msg);

  /** The owner's add-on, or undefined (someone else's looks like none at all). */
  const own = async (accountId: string, id: string) => {
    const addon = await store.addons.get(id);
    return addon?.accountId === accountId ? addon : undefined;
  };

  /**
   * Someone the owner may give a share to: an active connection of theirs (here, or on a
   * server that takes shared add-ons), or a member of one of their spaces. Never themselves.
   */
  const resolve = async (owner: Account, ref: string): Promise<ShareHolder | string> => {
    const [kind, id = ""] = ref.split(":");
    if (kind === "conn") {
      const c = await store.connections.get(id);
      if (c?.accountId !== owner.id || c.state !== "active" || !c.peerAccount) {
        return "That connection isn't active.";
      }
      if (c.peerHost === LOCAL_HOST && c.peerAccount === owner.id) return "That's you.";
      if (c.peerHost !== LOCAL_HOST) {
        if (!federates(env) || !(await peerSupports(env, c.peerHost, "addon-shares"))) {
          return `${UNAVAILABLE["addon-shares"]} (${c.peerHost}).`;
        }
      }
      return {
        host: c.peerHost,
        accountId: c.peerAccount,
        handle: c.peerHandle,
        name: (c.peerName || c.peerHandle).slice(0, 64),
        connectionId: c.id,
      };
    }
    const user = await store.getUser(id);
    const mine = new Set((await store.listMemberships(owner.id)).map((m) => m.household.id));
    if (!user || !mine.has(user.householdId)) return "That person isn't in your spaces.";
    if (user.accountId === owner.id) return "That's you.";
    const account = await store.getAccount(user.accountId);
    if (!account) return "That person isn't in your spaces.";
    return {
      host: LOCAL_HOST,
      accountId: account.id,
      handle: account.handle,
      name: user.name.slice(0, 64),
      connectionId: null,
    };
  };

  const view = async (addon: Addon, handle: string) => {
    const [shares, grants] = await Promise.all([
      store.addons.shares(addon.id),
      store.addons.grants(addon.id),
    ]);
    return {
      id: addon.id,
      name: addon.name,
      address: addonAddress(env, handle, addon.name),
      online: env.addons ? await live.isOnline(addon.householdId, addon.id) : false,
      lastSeen: addon.lastSeen,
      fw: addon.fw,
      createdAt: addon.createdAt,
      space: (await store.getHousehold(addon.householdId))?.name ?? "",
      shares: shares.map((s) => ({
        id: s.id,
        label: s.label,
        address: shareAddress(env, handle, addon.name, s.id),
        holders: grants
          .filter((g) => g.shareId === s.id)
          .map((g) => ({ grantId: g.id, name: g.name, address: holderAddress(env, g) })),
      })),
      allowNote: await store.addons.allowNote(addon.id),
    };
  };

  api.get("/addons", async (c) => {
    const account = c.get("account");
    const addons = await store.addons.list(account.id);
    return c.json({
      enabled: env.addons === true,
      addons: await Promise.all(addons.map((a) => view(a, account.handle))),
    });
  });

  /** Who you can give a share to: your active connections and the people in your spaces. */
  api.get("/addons/people", async (c) => {
    const account = c.get("account");
    const seen = new Set<string>();
    const out: { ref: string; name: string; address: string; where: string }[] = [];
    for (const conn of await store.connections.list(account.id)) {
      if (conn.state !== "active" || !conn.peerAccount) continue;
      const key = `${conn.peerHost}|${conn.peerAccount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ref: `conn:${conn.id}`,
        name: conn.peerName || conn.peerHandle,
        address: holderAddress(env, { host: conn.peerHost, handle: conn.peerHandle }),
        where: "connection",
      });
    }
    for (const m of await store.listMemberships(account.id)) {
      for (const u of await store.listUsers(m.household.id)) {
        if (!u.accountId || u.accountId === account.id) continue;
        const key = `|${u.accountId}`;
        if (seen.has(key)) continue;
        const other = await store.getAccount(u.accountId);
        if (!other) continue;
        seen.add(key);
        out.push({
          ref: `user:${u.id}`,
          name: u.name,
          address: holderAddress(env, { host: LOCAL_HOST, handle: other.handle }),
          where: m.household.name,
        });
      }
    }
    return c.json(out);
  });

  /**
   * What you can call of other people's add-ons here: the shares of them you hold (on this
   * server; shares from other servers come with that connection). Only shares that work now.
   */
  api.get("/addons/shared", async (c) => {
    const account = c.get("account");
    if (!env.addons) return c.json({ held: [] });
    const held = [];
    for (const h of await store.addons.heldBy(account.id)) {
      const addon = await store.addons.get(h.addonId);
      if (!addon) continue;
      const may = await addonAccess(
        env,
        addon,
        { host: LOCAL_HOST, accountId: account.id, handle: account.handle },
        h.shareId,
      );
      if (!may) continue;
      held.push({
        grantId: h.id,
        owner: { name: h.ownerName, address: `${h.ownerHandle}@${ownHost(env)}` },
        addon: h.addonName,
        share: { id: h.shareId, label: h.label },
        address: shareAddress(env, h.ownerHandle, h.addonName, h.shareId),
      });
    }
    return c.json({ held });
  });

  api.post("/addons/link", async (c) => {
    if (!env.addons) return c.json({ error: ADDONS_OFF }, 403);
    const user = c.get("user");
    const account = c.get("account");
    const b = await body(c.req.raw, LinkBody);
    if (b instanceof Response) return b;
    const pending = await store.peekPairing(b.code, env.now());
    if (pending && !pending.addon) return c.json({ error: PHONE_CODE }, 400);
    if ((await store.addons.list(account.id)).length >= MAX_ADDONS_PER_ACCOUNT) {
      return c.json({ error: `You can link up to ${MAX_ADDONS_PER_ACCOUNT} add-ons.` }, 403);
    }
    const linked = await store.addons.link(
      {
        code: b.code,
        accountId: account.id,
        householdId: user.householdId,
        userId: user.id,
        name: b.name,
      },
      env.now(),
    );
    if (linked === "name_taken") {
      return c.json({ error: `You already have an add-on called ${b.name}.` }, 409);
    }
    if (linked === "no_code") return c.json({ error: "unknown or expired code" }, 404);
    await live.notifyPaired(b.code, { id: linked.id, householdId: linked.householdId });
    await auditAddon(env, linked, "addon.link", {});
    return c.json(await view(linked, account.handle), 201);
  });

  /** The one-time note that the old "who may talk to it" entries were removed: seen. */
  api.post("/addons/:id/note/dismiss", async (c) => {
    const addon = await own(c.get("account").id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    await store.addons.dismissAllowNote(addon.id);
    return c.body(null, 204);
  });

  /** Gives one of its shares to someone. */
  api.post("/addons/:id/shares/:share/grants", async (c) => {
    if (!env.addons) return c.json({ error: ADDONS_OFF }, 403);
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    const share = await store.addons.share(addon.id, c.req.param("share"));
    if (!share) return c.json({ error: `${addon.name} doesn't offer that share any more.` }, 404);
    const b = await body(c.req.raw, GrantBody);
    if (b instanceof Response) return b;
    const holder = await resolve(account, b.to);
    if (typeof holder === "string") return c.json({ error: holder }, 409);
    const held = (await store.addons.grants(addon.id)).filter((g) => g.shareId === share.id);
    if (held.length >= MAX_HOLDERS_PER_SHARE) {
      return c.json({ error: `A share can go to up to ${MAX_HOLDERS_PER_SHARE} people.` }, 403);
    }
    const [grant] = await giveShare(env, notify, addon, share.id, [holder]);
    if (!grant) return c.json({ error: `${addon.name} doesn't offer that share any more.` }, 404);
    return c.json({ grantId: grant.id, name: grant.name, address: holderAddress(env, grant) }, 201);
  });

  /** Takes a share back from someone: their calls into it end at once. */
  api.delete("/addons/:id/grants/:grant", async (c) => {
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    const grant = addon && (await store.addons.getGrant(c.req.param("grant")));
    if (!addon || grant?.addonId !== addon.id) return c.json({ error: "not found" }, 404);
    await store.addons.revoke(grant.id);
    await live.endAddonShareCalls(addon.householdId, addon.id, { grantIds: [grant.id] });
    await tellHolder(env, notify, addon.accountId, grant);
    await auditAddon(env, addon, "addon.revoke", {
      share: grant.shareId,
      grantId: grant.id,
      from: holderAddress(env, grant),
    });
    return c.body(null, 204);
  });

  /**
   * "New shared project with…": asks the add-on for a new share for these people. It answers
   * on its socket; the app follows the request with GET until it's settled.
   */
  api.post("/addons/:id/share-requests", async (c) => {
    if (!env.addons) return c.json({ error: ADDONS_OFF }, 403);
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, RequestBody);
    if (b instanceof Response) return b;
    const holders: ShareHolder[] = [];
    for (const ref of new Set(b.with)) {
      const h = await resolve(account, ref);
      if (typeof h === "string") return c.json({ error: h }, 409);
      if (!holders.some((x) => x.host === h.host && x.accountId === h.accountId)) holders.push(h);
    }
    const online = await live.isOnline(addon.householdId, addon.id);
    let req = await store.addons.createRequest(
      { addonId: addon.id, label: b.label, holders, state: online ? "waiting" : "offline" },
      env.now(),
    );
    await auditAddon(env, addon, "addon.share.request", {
      requestId: req.id,
      label: req.label,
      people: holders.length,
    });
    if (online) {
      const msg: ServerToDevice = {
        t: "addon.share.request",
        requestId: req.id,
        label: req.label,
        by: `${account.handle}@${ownHost(env)}`,
        with: holders.map((h) => holderAddress(env, h)),
      };
      if (!(await live.addonShareRequest(addon.householdId, addon.id, msg))) {
        await store.addons.settleRequest(req.id, { state: "offline" }, env.now());
        req = (await store.addons.getRequest(req.id)) ?? req;
      }
    }
    if (req.state === "offline") {
      await auditAddon(env, addon, "addon.share.offline", { requestId: req.id, label: req.label });
    }
    return c.json(await requestView(env, addon, req), 202);
  });

  api.get("/addons/:id/share-requests/:request", async (c) => {
    const addon = await own(c.get("account").id, c.req.param("id"));
    const req = addon && (await store.addons.getRequest(c.req.param("request")));
    if (!addon || req?.addonId !== addon.id) return c.json({ error: "not found" }, 404);
    return c.json(await requestView(env, addon, req));
  });

  api.delete("/addons/:id", async (c) => {
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    const grants = await store.addons.grants(addon.id);
    await store.addons.delete(addon.id);
    // If it's offline now, it's told to forget its link the next time it connects.
    await store.recordRemovedDevices(
      [{ id: addon.id, publicKey: addon.publicKey, keyAlg: addon.keyAlg }],
      env.now(),
    );
    await live.forgetDevice(addon.householdId, addon.id);
    // The people who held its shares see them go.
    for (const g of grants) await tellHolder(env, notify, addon.accountId, g);
    await auditAddon(env, addon, "addon.remove", {});
    return c.body(null, 204);
  });
}
