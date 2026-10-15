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
  type AddonSelf,
  LOCAL_HOST,
  type ShareHolder,
  type ShareRequest,
} from "@openloungephone/db";
import { ADDON_NAME_RE, formatAddonAddress, parseAddonAddress } from "@openloungephone/federation";
import type {
  AddonAbout,
  DeviceToServer,
  ServerToApp,
  ServerToDevice,
} from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { audit } from "./audit.ts";
import type { AddonRules, ServerEnv } from "./env.ts";
import { fedFetch, ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";
import { federates } from "./ownKey.ts";
import { peerSupports, UNAVAILABLE } from "./peers.ts";

/** What linking says when the server's operator hasn't turned add-ons on. */
export const ADDONS_OFF = "This server doesn't offer add-ons. Its operator can turn them on.";
/** A phone's pairing screen, given an add-on's code. */
export const ADDON_CODE = "That code is for an add-on: link it under Add-ons.";
/** The add-ons screen, given a phone's code. */
export const PHONE_CODE = "That code is for a phone: add it under Phones.";
/** `call.ringing.share.grantId` when its owner calls within one of its shares. */
export const OWNER_GRANT = "owner";
/** Add-on addresses one account may keep in its contacts. */
export const MAX_ADDON_CONTACTS = 50;
/** How many add-ons one account may link. */
export const MAX_ADDONS_PER_ACCOUNT = 10;
/** How long the owner's "Ask it for a new share…" waits for the add-on's answer. */
export const SHARE_REQUEST_MS = 60_000;
/** How many people one share may be given to. */
export const MAX_HOLDERS_PER_SHARE = 50;

/**
 * Everything an add-on may send once it is signed in (docs/security-model.md, Add-ons). This is
 * an allow-list: any other message, including every message type added to the device protocol
 * later, is answered with an `error` and has no effect. Before signing in it may send only
 * `hello`, `pair.begin` and `auth.proof` (the gateway's handshake).
 */
export const ADDON_MESSAGES: ReadonlySet<DeviceToServer["t"]> = new Set<DeviceToServer["t"]>([
  "ping",
  "addon.about",
  "addon.shares",
  "addon.share.created",
  "addon.share.refused",
  "call.address",
  "call.answer",
  "call.hangup",
  "rtc.sdp",
  "rtc.ice",
]);

/** The rules for an add-on that never said what it does: as server 0.7.0 had them. */
export const LEGACY_RULES: AddonRules = {
  answers: true,
  calls: true,
  shares: true,
  keys: true,
  lines: 1,
};

/** What the server lets an add-on do, from what it said about itself. */
export function rulesOf(env: ServerEnv, about: AddonSelf | null | undefined): AddonRules {
  if (!about) return LEGACY_RULES;
  return {
    answers: about.answers,
    calls: about.calls,
    shares: about.shares,
    keys: about.keys,
    lines: Math.max(1, Math.min(about.lines, limitsOf(env).addonCallsAtOnce)),
  };
}

/** `addon.about` with its defaults filled in, its words cleaned (undefined: unusable words). */
export function selfOf(msg: AddonAbout): AddonSelf | string {
  const summary = msg.summary === undefined ? undefined : cleanText(msg.summary, 140);
  if (summary === null) return "summary: use plain words (no control characters)";
  return {
    ...(summary ? { summary } : {}),
    hears: msg.hears,
    transcribes: msg.transcribes ?? false,
    answers: msg.answers ?? true,
    calls: msg.calls ?? false,
    shares: msg.shares ?? false,
    keys: msg.keys ?? false,
    lines: msg.lines ?? 1,
  };
}

/**
 * Text an add-on chose that people will read (a share's label, its summary, a refusal): no
 * control, format (e.g. right-to-left overrides), private-use or line-break characters, spaces
 * collapsed, and at least one letter or digit. Answers the cleaned text, or null if it can't be
 * shown as it is. The apps and phones mark every add-on as one wherever this text appears.
 */
export function cleanText(text: string, max: number): string | null {
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u.test(text)) return null;
  const t = text.replace(/\s+/gu, " ").trim();
  if (!t || t.length > max || !/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A caller over their limit of calls to one add-on. */
export const TOO_MANY_CALLS_TO = "Too many calls to this add-on. Try again later.";
/** An add-on over its limit of calls out. */
export const TOO_MANY_CALLS_FROM = "This add-on has made too many calls. It can call again later.";

/** Counts one event; over the limit, audits the first refusal of the window (no content). */
async function counted(
  env: ServerEnv,
  addon: Addon,
  bucket: string,
  windowMs: number,
  limit: number,
  what: string,
): Promise<boolean> {
  const now = env.now();
  if (await env.store.connections.hit(bucket, windowMs, limit, now)) return true;
  if ((await env.store.connections.counted(bucket, windowMs, now)) === limit + 1) {
    await auditAddon(env, addon, "addon.limit", { what });
  }
  return false;
}

/**
 * Someone allowed to call an add-on, over their hourly limit of calls to it: the words to say
 * (undefined: within it).
 */
export async function addonCallerLimited(
  env: ServerEnv,
  addon: Addon,
  who: { host: string; accountId: string },
): Promise<string | undefined> {
  const ok = await env.store.connections.hit(
    `addon-in:${addon.id}:${who.host}:${who.accountId}`,
    HOUR_MS,
    limitsOf(env).addonCallsInPerCallerPerHour,
    env.now(),
  );
  return ok ? undefined : TOO_MANY_CALLS_TO;
}

/**
 * An add-on about to call someone it may call: over its hourly limit, or its daily limit for that
 * person? The words to say (undefined: within them). So it can't ring all its holders at once
 * like a broadcast.
 */
export async function addonCallsOutLimited(
  env: ServerEnv,
  addon: Addon,
  callee: { host: string; accountId: string },
): Promise<string | undefined> {
  const limits = limitsOf(env);
  const hour = await counted(
    env,
    addon,
    `addon-out:${addon.id}`,
    HOUR_MS,
    limits.addonCallsOutPerHour,
    "calls per hour",
  );
  if (!hour) return TOO_MANY_CALLS_FROM;
  const person = await counted(
    env,
    addon,
    `addon-out:${addon.id}:${callee.host}:${callee.accountId}`,
    DAY_MS,
    limits.addonCallsOutPerPersonPerDay,
    "calls to one person per day",
  );
  return person ? undefined : TOO_MANY_CALLS_FROM;
}

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
  // Its owner may talk to it within any of its shares too (the add-on is told `owner`).
  if (who.host === LOCAL_HOST && who.accountId === addon.accountId) {
    return { share: { id: share.id, label: share.label, grantId: OWNER_GRANT } };
  }
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

/** What people other than its owner see of what an add-on said about itself. */
export const publicAbout = (a: AddonSelf) => ({
  ...(a.summary ? { summary: a.summary } : {}),
  hears: a.hears,
  transcribes: a.transcribes,
  answers: a.answers,
  calls: a.calls,
  keys: a.keys,
});

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

/**
 * Unlinks an add-on (its owner removed it, left the space it was linked in, or the space or their
 * account went): the row goes with its shares and grants, its socket closes with its calls, it
 * is told to forget its link (now, or when it next connects and proves its key), and the people
 * who held its shares see them go.
 */
export async function unlinkAddon(env: ServerEnv, live: Coordinator, addon: Addon): Promise<void> {
  const { store } = env;
  const grants = await store.addons.grants(addon.id);
  await store.addons.delete(addon.id);
  await store.recordRemovedDevices(
    [{ id: addon.id, publicKey: addon.publicKey, keyAlg: addon.keyAlg }],
    env.now(),
  );
  await live.forgetDevice(addon.householdId, addon.id);
  const notify = (accountId: string, msg: ServerToApp) => live.notifyAccount(accountId, msg);
  for (const g of grants) await tellHolder(env, notify, addon.accountId, g);
}

/**
 * A holder gave a share back (here, or their server told us): their calls within it end, its
 * owner's apps reload, and it goes in the audit trail.
 */
export async function holderLeft(
  env: ServerEnv,
  live: Coordinator,
  addon: Addon,
  grant: AddonGrant,
): Promise<void> {
  await live.endAddonShareCalls(addon.householdId, addon.id, { grantIds: [grant.id] });
  await live.notifyAccount(addon.accountId, { t: "connections.changed" });
  await auditAddon(env, addon, "addon.leave", {
    share: grant.shareId,
    grantId: grant.id,
    from: holderAddress(env, grant),
  });
}

/** Unlinks the add-ons a membership, a space or an account takes with it when it goes. */
export async function unlinkAddonsOf(
  env: ServerEnv,
  live: Coordinator,
  which: { accountId: string; userId?: string; householdId?: string },
): Promise<void> {
  for (const addon of await env.store.addons.list(which.accountId)) {
    if (which.userId && addon.userId !== which.userId) continue;
    if (which.householdId && addon.householdId !== which.householdId) continue;
    await unlinkAddon(env, live, addon);
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
const AddonAddressText = z.string().trim().min(5).max(300);
const MutedBody = z.object({ address: AddonAddressText, muted: z.boolean() });
const LeaveBody = z.object({ address: AddonAddressText });
const ContactBody = z.object({
  address: AddonAddressText,
  label: z.string().trim().min(1).max(40).optional(),
});
const RequestBody = z.object({
  label: z.string().trim().min(1, "Give it a name.").max(40),
  with: z.array(PersonRef).max(MAX_HOLDERS_PER_SHARE),
});

/** the Add-ons tab: link (with the add-on's code), list, shares and who holds them, remove. */
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
      // What it said it does (null: it never said), and what the server lets it do.
      about: addon.about,
      rules: rulesOf(env, addon.about),
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
      const mute = { host: LOCAL_HOST, ownerAccount: addon.accountId, name: addon.name };
      held.push({
        grantId: h.id,
        owner: { name: h.ownerName, address: `${h.ownerHandle}@${ownHost(env)}` },
        addon: h.addonName,
        share: { id: h.shareId, label: h.label },
        address: shareAddress(env, h.ownerHandle, h.addonName, h.shareId),
        muted: await store.addons.muted(account.id, mute),
        ...(addon.about ? { about: publicAbout(addon.about) } : {}),
      });
    }
    return c.json({ held });
  });

  /**
   * An add-on someone holds a share of, by address (`handle+name[+share]@host`): its owner's
   * server and stable account there, and, for one elsewhere, the connection it came through.
   */
  const heldAddon = async (account: Account, address: string) => {
    const a = parseAddonAddress(address);
    if (!a) return undefined;
    const host = a.host === ownHost(env) ? LOCAL_HOST : a.host;
    if (host === LOCAL_HOST) {
      const addon = await store.addons.byAddress(a.handle, a.name);
      return addon ? { a, host, ownerAccount: addon.accountId, addon } : undefined;
    }
    const conn = await store.connections.find(account.id, host, a.handle);
    if (conn?.state !== "active" || !conn.peerAccount) return undefined;
    return { a, host, ownerAccount: conn.peerAccount, conn };
  };

  /**
   * An add-on (or one of its shares) this account may call now, by address: its own, a share of
   * its own, or a share given to it (here, or by a connection's server). Answers its address in
   * canonical form and what to call it, or undefined.
   */
  const callable = async (account: Account, address: string) => {
    const a = parseAddonAddress(address);
    if (!a || !env.addons) return undefined;
    const host = a.host === ownHost(env) ? LOCAL_HOST : a.host;
    const canonical = formatAddonAddress({ ...a, host: host || ownHost(env) });
    if (host === LOCAL_HOST) {
      const addon = await store.addons.byAddress(a.handle, a.name);
      const who = { host: LOCAL_HOST, accountId: account.id, handle: account.handle };
      const access = addon && (await addonAccess(env, addon, who, a.share));
      if (!addon || !access) return undefined;
      return {
        address: canonical,
        label: access.share ? `${addon.name} · ${access.share.label}` : addon.name,
      };
    }
    const conn = await store.connections.find(account.id, host, a.handle);
    if (conn?.state !== "active" || !a.share) return undefined;
    const held = (await store.addons.received(conn.id)).find(
      (x) => x.addon === a.name && x.share === a.share,
    );
    return held && { address: canonical, label: `${a.name} · ${held.label}` };
  };

  /** Add-ons in your contacts (Home's call list): each with whether you can call it now. */
  api.get("/addons/contacts", async (c) => {
    const account = c.get("account");
    const out = [];
    for (const x of await store.addons.contacts(account.id)) {
      out.push({ ...x, ok: !!(await callable(account, x.address)) });
    }
    return c.json(out);
  });

  /** Adds an add-on (or a share) you may call to your contacts. */
  api.put("/addons/contacts", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, ContactBody);
    if (b instanceof Response) return b;
    const it = await callable(account, b.address);
    if (!it) return c.json({ error: "You can't call that add-on." }, 404);
    const have = await store.addons.contacts(account.id);
    if (!have.some((x) => x.address === it.address) && have.length >= MAX_ADDON_CONTACTS) {
      return c.json(
        { error: `You can keep up to ${MAX_ADDON_CONTACTS} add-ons in contacts.` },
        403,
      );
    }
    const label = b.label === undefined ? it.label : cleanText(b.label, 40);
    if (!label) return c.json({ error: "Use plain words for its name." }, 400);
    await store.addons.setContact(account.id, it.address, label, env.now());
    await notify(account.id, { t: "connections.changed" });
    return c.json({ address: it.address, label });
  });

  api.delete("/addons/contacts", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, LeaveBody);
    if (b instanceof Response) return b;
    await store.addons.removeContact(account.id, b.address.trim().toLowerCase());
    await notify(account.id, { t: "connections.changed" });
    return c.body(null, 204);
  });

  /**
   * "Stop its calls" (or let them through again): a holder's own choice, kept and enforced by
   * their own server. They can still call it.
   */
  api.put("/addons/muted", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, MutedBody);
    if (b instanceof Response) return b;
    const held = await heldAddon(account, b.address);
    if (!held || held.ownerAccount === account.id) return c.json({ error: "not found" }, 404);
    const who = { host: held.host, ownerAccount: held.ownerAccount, name: held.a.name };
    await store.addons.setMuted(account.id, who, b.muted, env.now());
    await notify(account.id, { t: "connections.changed" });
    return c.body(null, 204);
  });

  /** A holder gives a share back: they lose it, and their calls within it end. */
  api.post("/addons/leave", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, LeaveBody);
    if (b instanceof Response) return b;
    const held = await heldAddon(account, b.address);
    const share = held?.a.share;
    if (!held || !share) return c.json({ error: "not found" }, 404);
    if (held.addon) {
      const grant = await store.addons.grantFor(held.addon.id, share, LOCAL_HOST, account.id);
      if (!grant || !(await store.addons.leave(grant.id, account.id))) {
        return c.json({ error: "not found" }, 404);
      }
      await holderLeft(env, live, held.addon, grant);
    } else if (held.conn) {
      const had = (await store.addons.received(held.conn.id)).some(
        (x) => x.addon === held.a.name && x.share === share,
      );
      if (!had) return c.json({ error: "not found" }, 404);
      // Forgotten here at once (its calls to us within it are refused from now on); its
      // server is told, if it can be.
      await store.addons.dropReceived(held.conn.id, held.a.name, share);
      if (federates(env) && (await peerSupports(env, held.host, "addon-leave"))) {
        try {
          await fedFetch(env, held.host, "/addon-shares/leave", {
            json: { from: partyOf(account), to: held.a.handle, addon: held.a.name, share },
          });
        } catch (e) {
          env.log("warn", "add-on share leave not delivered", {
            host: held.host,
            error: String(e),
          });
        }
      }
    }
    await notify(account.id, { t: "connections.changed" });
    return c.body(null, 204);
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
   * "Ask it for a new share…": asks the add-on for a new share for these people. It answers
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
    await auditAddon(env, addon, "addon.remove", {});
    await unlinkAddon(env, live, addon);
    return c.body(null, 204);
  });
}
