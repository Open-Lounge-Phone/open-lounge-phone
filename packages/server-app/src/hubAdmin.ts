// Running a public hub: the fair-use allowance you've used, funding transparency, and the
// operator's minimal admin view (suspend or exempt an account, block a server).
import { fundingSummary } from "@openloungephone/core";
import { monthEnds } from "@openloungephone/db";
import { HOST_RE } from "@openloungephone/federation";
import type { Hono } from "hono";
import { z } from "zod";
import { isOperator } from "./accounts.ts";
import type { ServerEnv } from "./env.ts";
import { resetsOn } from "./fairUse.ts";
import { body, type Vars } from "./httpUtil.ts";

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
    return c.body(null, 204);
  });

  api.post("/admin/accounts/:id/exempt", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, Flag("exempt"));
    if (b instanceof Response) return b;
    const target = await store.getAccount(c.req.param("id"));
    if (!target) return c.json({ error: "not found" }, 404);
    await store.setFairUseExempt(target.id, b.exempt as boolean);
    return c.body(null, 204);
  });

  api.post("/admin/servers/block", async (c) => {
    if (!(await operator(c))) return refused();
    const b = await body(c.req.raw, BlockBody);
    if (b instanceof Response) return b;
    if (!HOST_RE.test(b.host)) return c.json({ error: "not a server name" }, 400);
    await store.connections.blockServer(b.host, b.reason ?? null, env.now());
    return c.body(null, 204);
  });

  api.delete("/admin/servers/:host", async (c) => {
    if (!(await operator(c))) return refused();
    await store.connections.unblockServer(c.req.param("host").toLowerCase());
    return c.body(null, 204);
  });
}
