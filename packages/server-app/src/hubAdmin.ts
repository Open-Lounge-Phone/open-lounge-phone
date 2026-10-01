// Running a public hub: the fair-use allowance you've used, funding transparency, and the
// operator's minimal admin view (suspend or exempt an account, block a server).
import { fundingSummary } from "@openloungephone/core";
import { monthEnds } from "@openloungephone/db";
import {
  FEATURE_NAMES,
  FEATURES,
  generateServerKey,
  HOST_RE,
  keyFingerprint,
  type PeerOffer,
} from "@openloungephone/federation";
import type { Hono } from "hono";
import { z } from "zod";
import { isOperator } from "./accounts.ts";
import type { ServerEnv } from "./env.ts";
import { resetsOn } from "./fairUse.ts";
import { ownHost } from "./federation.ts";
import { body, type Vars } from "./httpUtil.ts";
import { operatorAudit, ownKeys, rotateOwnKey } from "./ownKey.ts";
import { knownOffers } from "./peers.ts";

/** Public: what this server asks of its users and how it's funded (hubs only). */
export function publicHubRoutes(api: Hono<Vars>, env: ServerEnv): void {
  api.get("/hub", (c) =>
    c.json({
      fairUse: env.fairUse ?? null,
      funding: env.hub?.funding
        ? { ...env.hub.funding, summary: fundingSummary(env.hub.funding) }
        : null,
      sponsorUrl: env.hub?.sponsorUrl ?? null,
    }),
  );
}

const Flag = (name: string) => z.object({ [name]: z.boolean() });
const BlockBody = z.object({
  host: z.string().trim().toLowerCase().min(1).max(260),
  reason: z.string().trim().max(200).optional(),
});
const RotateBody = z.object({ force: z.boolean().optional() });
const Fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9_-]{43}$/);
/** Re-trust needs both fingerprints the operator was shown: proof they saw this exact change. */
const RetrustBody = z.object({ from: Fingerprint, to: Fingerprint });

export function hubRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  /** Your use this month against the fair-use allowance (null limits = unlimited). */
  api.get("/usage", async (c) => {
    const account = c.get("account");
    const now = env.now();
    return c.json({
      ...(await store.usage(account.id, now)),
      resetsAt: monthEnds(now),
      resetsOn: resetsOn(now),
      limits: env.fairUse ?? null,
      exempt: account.fairUseExempt,
    });
  });

  const operator = async (c: { get(k: "account"): import("@openloungephone/db").Account }) =>
    isOperator(env, c.get("account"));
  const refused = () => Response.json({ error: "operators only" }, { status: 403 });

  api.get("/admin/overview", async (c) => {
    if (!(await operator(c))) return refused();
    return c.json({
      counts: await store.hubCounts(),
      blockedServers: await store.connections.blockedServers(),
      keyAlerts: await store.connections.keyAlerts(),
    });
  });

  api.get("/admin/accounts", async (c) => {
    if (!(await operator(c))) return refused();
    const handle = (c.req.query("handle") ?? "").trim().toLowerCase().replace(/@.*$/, "");
    const account = handle ? await store.accountByHandle(handle) : undefined;
    if (!account) return c.json({ error: "not found" }, 404);
    return c.json({
      id: account.id,
      handle: account.handle,
      name: account.name,
      createdAt: account.createdAt,
      suspended: account.suspendedAt !== null,
      exempt: account.fairUseExempt,
      usage: await store.usage(account.id, env.now()),
      spaces: (await store.listMemberships(account.id)).length,
    });
  });

  api.post("/admin/accounts/:id/suspend", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, Flag("suspended"));
    if (b instanceof Response) return b;
    const target = await store.getAccount(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    if (target.id === c.get("account").id) return c.json({ error: "not yourself" }, 400);
    await store.setSuspended(target.id, b.suspended ? env.now() : null);
    await operatorAudit(
      env,
      c.get("account"),
      b.suspended ? "account.suspend" : "account.unsuspend",
      {
        accountId: target.id,
        handle: target.handle,
      },
    );
    return c.body(null, 204);
  });

  api.post("/admin/accounts/:id/exempt", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, Flag("exempt"));
    if (b instanceof Response) return b;
    const target = await store.getAccount(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    await store.setFairUseExempt(target.id, b.exempt as boolean);
    await operatorAudit(env, c.get("account"), b.exempt ? "account.exempt" : "account.unexempt", {
      accountId: target.id,
      handle: target.handle,
    });
    return c.body(null, 204);
  });

  api.post("/admin/servers/block", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, BlockBody);
    if (b instanceof Response) return b;
    if (!HOST_RE.test(b.host)) return c.json({ error: "not a server name" }, 400);
    await store.connections.blockServer(b.host, b.reason ?? null, env.now());
    await operatorAudit(env, c.get("account"), "server.block", {
      host: b.host,
      ...(b.reason ? { reason: b.reason } : {}),
    });
    return c.body(null, 204);
  });

  api.delete("/admin/servers/:host", async (c) => {
    if (!(await operator(c))) return refused();
    const host = c.req.param("host").toLowerCase();
    await store.connections.unblockServer(host);
    await operatorAudit(env, c.get("account"), "server.unblock", { host });
    return c.body(null, 204);
  });

  // --- federation keys: ours (rotation) and other servers' pins -----------------------------

  /** What a peer last advertised: software, federation versions, features (absent: unknown). */
  const offerView = (o: PeerOffer | undefined) =>
    o
      ? {
          software: o.software ?? null,
          versions: Object.keys(o.versions).map(Number),
          features: [...o.features].filter((f) => f in FEATURES),
          /** Features this server has and the peer doesn't advertise (they degrade). */
          missing: FEATURE_NAMES.filter((f) => !o.features.has(f)),
        }
      : { software: null, versions: [], features: [], missing: [] };

  /** This server's key (fingerprints only) and every other server's pinned key. */
  api.get("/admin/federation", async (c) => {
    if (!(await operator(c))) return refused();
    const keys = await ownKeys(env);
    const blocked = new Set((await store.connections.blockedServers()).map((b) => b.host));
    const fp = keyFingerprint;
    const offers = await knownOffers(env);
    const peers = await Promise.all(
      (await store.connections.pinnedKeys()).map(async (k) => ({
        ...offerView(offers.get(k.host)),
        host: k.host,
        fingerprint: await fp(k.publicKey),
        firstSeen: k.firstSeen,
        keySince: k.keySince,
        lastSeen: k.lastSeen,
        status: k.rejected ? ("rejected_change" as const) : ("pinned" as const),
        rejected: k.rejected
          ? { fingerprint: await fp(k.rejected.publicKey), at: k.rejected.at }
          : null,
        blocked: blocked.has(k.host),
      })),
    );
    const r = keys?.rotation;
    return c.json({
      own: keys
        ? {
            host: ownHost(env, c.req.url),
            fingerprint: await fp(keys.current.publicKey),
            rotation: r
              ? {
                  previousFingerprint: await fp(r.previous_key),
                  createdAt: r.created * 1000,
                  expiresAt: r.expires * 1000,
                }
              : null,
          }
        : null,
      peers,
    });
  });

  /**
   * Rotates this server's key: a new key signs from now on, and `.well-known` publishes the old
   * one with the hand-over for the overlap window, so peers re-pin by themselves.
   */
  api.post("/admin/federation/rotate-key", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, RotateBody);
    if (b instanceof Response) return b;
    if (!env.publicUrl) return c.json({ error: "set PUBLIC_URL first" }, 400);
    const result = await rotateOwnKey(env, ownHost(env), {
      force: b.force === true,
      generate: generateServerKey,
    });
    if (!result.ok) {
      return c.json(
        { error: result.error, ...(result.until ? { until: result.until } : {}) },
        result.status as 404 | 409,
      );
    }
    const detail = {
      from: await keyFingerprint(result.previousKey),
      to: await keyFingerprint(result.publicKey),
      overlapUntil: result.expires * 1000,
      ...(b.force ? { forced: true } : {}),
    };
    env.log("info", "federation: rotated this server's key", detail);
    await operatorAudit(env, c.get("account"), "fedkey.rotate", detail);
    // Servers that don't advertise `key-rotation` can't follow the hand-over on their own: their
    // operators will see a refused key change and must re-trust it.
    const cannotFollow = [...(await knownOffers(env))]
      .filter(([, o]) => !o.features.has("key-rotation"))
      .map(([host]) => host);
    return c.json({ ...detail, ...(cannotFollow.length ? { cannotFollow } : {}) });
  });

  /**
   * Trusts a server's refused key change: replaces the pin with the key it now presents. The
   * body names both fingerprints, so it applies only to the change the operator looked at.
   */
  api.post("/admin/federation/peers/:host/retrust", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, RetrustBody);
    if (b instanceof Response) return b;
    const host = c.req.param("host").toLowerCase();
    const row = await store.connections.pinnedKeyRow(host);
    if (!row?.rejected) return c.json({ error: "no refused key change for that server" }, 404);
    const [from, to] = [
      await keyFingerprint(row.publicKey),
      await keyFingerprint(row.rejected.publicKey),
    ];
    if (from !== b.from || to !== b.to) {
      return c.json({ error: "the key change is no longer the one shown; look again" }, 409);
    }
    if (
      !(await store.connections.repinKey(host, row.publicKey, row.rejected.publicKey, env.now()))
    ) {
      return c.json({ error: "the key just changed; look again" }, 409);
    }
    await operatorAudit(env, c.get("account"), "fedkey.retrust", { host, from, to });
    return c.body(null, 204);
  });

  /** The server-wide audit trail: operators' actions and automatic key changes. */
  api.get("/admin/audit", async (c) => {
    if (!(await operator(c))) return refused();
    const limit = Number(c.req.query("limit") ?? 100) || 100;
    const before = c.req.query("before");
    return c.json(await store.operatorAuditLog(limit, before ? Number(before) : undefined));
  });
}
