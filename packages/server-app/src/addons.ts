// Add-ons (docs/add-ons.md): services a person links to their own account. An add-on connects
// like a phone (pairing code, then a signed challenge on every connection) and is called at
// `handle+name@host`. Default deny: only its owner, and the connections its owner chose, may talk
// to it (either way); nobody can knock on it, it is in no directory, and kids' phones never reach
// one. The whole feature is off unless the server's operator turns it on (`ADDONS=on`).
import { type Addon, LOCAL_HOST } from "@openloungephone/db";
import { ADDON_NAME_RE } from "@openloungephone/federation";
import type { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";

/** What linking says when the server's operator hasn't turned add-ons on. */
export const ADDONS_OFF = "This server doesn't offer add-ons. Its operator can turn them on.";
/** A phone's pairing screen, given an add-on's code. */
export const ADDON_CODE = "That code is for an add-on: link it under Settings → Add-ons.";
/** The add-ons screen, given a phone's code. */
export const PHONE_CODE = "That code is for a phone: add it under Phones.";
/** How many add-ons one account may link. */
export const MAX_ADDONS_PER_ACCOUNT = 10;

/** `handle+name@host`. */
export const addonAddress = (env: ServerEnv, handle: string, name: string) =>
  `${handle}+${name}@${ownHost(env)}`;

/**
 * Whether someone may talk to `addon`, either way: its owner (an account on this server), or one
 * of the owner's active connections that the owner put on its allow-list. `who` is the person's
 * server ('' = this one) and their account there. Everything else is refused, and so is
 * everything while add-ons are off or the owner's account is suspended.
 */
export async function mayTalk(
  env: ServerEnv,
  addon: Addon,
  who: { host: string; accountId: string; handle: string },
): Promise<boolean> {
  if (!env.addons) return false;
  const { store } = env;
  const owner = await store.getAccount(addon.accountId);
  if (!owner || owner.suspendedAt !== null) return false;
  if (who.host === LOCAL_HOST && who.accountId === addon.accountId) return true;
  const peer = { id: who.accountId, handle: who.handle };
  const conn = await store.connections.findPeer(addon.accountId, who.host, peer);
  if (conn?.state !== "active" || conn.peerAccount !== who.accountId) return false;
  if (await store.connections.blocked(addon.accountId, who.host, peer)) return false;
  return store.addons.isAllowed(addon.id, conn.id);
}

const Name = z
  .string()
  .trim()
  .toLowerCase()
  .regex(ADDON_NAME_RE, "Use 2 to 30 letters, digits, dots, dashes or underscores.");
const Allow = z.array(z.string().min(1).max(64)).max(200);
const LinkBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  name: Name,
  allow: Allow.optional(),
});
const AllowBody = z.object({ connections: Allow });

/** Settings → Add-ons: link (with the add-on's code), list, who may talk to it, remove. */
export function addonRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** The owner's add-on, or undefined (someone else's looks like none at all). */
  const own = async (accountId: string, id: string) => {
    const addon = await store.addons.get(id);
    return addon?.accountId === accountId ? addon : undefined;
  };

  /** Keeps only the account's active connections (in the order given). */
  const activeConnections = async (accountId: string, ids: string[]) => {
    const active = new Set(
      (await store.connections.list(accountId))
        .filter((c) => c.state === "active" && c.peerAccount)
        .map((c) => c.id),
    );
    return [...new Set(ids)].filter((id) => active.has(id));
  };

  /** Audited in the space the add-on was linked in, as its owner there. */
  const auditAddon = async (
    addon: Addon,
    accountId: string,
    action: string,
    detail: Record<string, unknown>,
  ) => {
    const [user, account] = await Promise.all([
      store.getUser(addon.userId),
      store.getAccount(accountId),
    ]);
    if (user && account) {
      await audit(env, { user, account }, action, {
        addonId: addon.id,
        name: addon.name,
        ...detail,
      });
    }
  };

  const view = async (addon: Addon, handle: string) => ({
    id: addon.id,
    name: addon.name,
    address: addonAddress(env, handle, addon.name),
    online: env.addons ? await live.isOnline(addon.householdId, addon.id) : false,
    lastSeen: addon.lastSeen,
    fw: addon.fw,
    createdAt: addon.createdAt,
    space: (await store.getHousehold(addon.householdId))?.name ?? "",
    allow: await store.addons.allowed(addon.id),
  });

  api.get("/addons", async (c) => {
    const account = c.get("account");
    const addons = await store.addons.list(account.id);
    return c.json({
      enabled: env.addons === true,
      addons: await Promise.all(addons.map((a) => view(a, account.handle))),
    });
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
    const allow = await activeConnections(account.id, b.allow ?? []);
    await store.addons.setAllowed(linked.id, allow);
    await live.notifyPaired(b.code, { id: linked.id, householdId: linked.householdId });
    await auditAddon(linked, account.id, "addon.link", { allowed: allow.length });
    return c.json(await view(linked, account.handle), 201);
  });

  api.put("/addons/:id/allow", async (c) => {
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, AllowBody);
    if (b instanceof Response) return b;
    const allow = await activeConnections(account.id, b.connections);
    await store.addons.setAllowed(addon.id, allow);
    await auditAddon(addon, account.id, "addon.allow", { allowed: allow.length });
    return c.json({ allow: await store.addons.allowed(addon.id) });
  });

  api.delete("/addons/:id", async (c) => {
    const account = c.get("account");
    const addon = await own(account.id, c.req.param("id"));
    if (!addon) return c.json({ error: "not found" }, 404);
    await store.addons.delete(addon.id);
    // If it's offline now, it's told to forget its link the next time it connects.
    await store.recordRemovedDevices(
      [{ id: addon.id, publicKey: addon.publicKey, keyAlg: addon.keyAlg }],
      env.now(),
    );
    await live.forgetDevice(addon.householdId, addon.id);
    await auditAddon(addon, account.id, "addon.remove", {});
    return c.body(null, 204);
  });
}
