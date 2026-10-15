// Missed calls in the apps (docs/phone-ux.md "Missed calls"): your calls that rang and nobody
// answered, with no message left, from every space you're in, and public lines' call backs you
// didn't take. Clearing them clears them on your phones too.
import type { Hono } from "hono";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import type { Vars } from "./httpUtil.ts";

/** How an app calls a missed caller back from the space it's in (none: from another space). */
export type CallBackHint =
  | { kind: "user"; userId: string }
  | { kind: "device"; deviceId: string }
  | { kind: "connection"; connectionId: string }
  | { kind: "line"; address: string };

export interface MissedView {
  id: string;
  /** `call`: rang, nobody answered, no message; `callback`: a public line's call back. */
  kind: "call" | "callback";
  from: string;
  /** The newest one. */
  at: number;
  count: number;
  /** The space it rang in (its name), when that isn't the one the app is in. */
  space?: string;
  callBack?: CallBackHint;
}

export function missedRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** Your missed calls (all your spaces) and missed call backs, newest first. */
  api.get("/missed", async (c) => {
    const user = c.get("user");
    const account = c.get("account");
    const here = user.householdId;
    const groups = await store.missed.list({ accountId: account.id }, 50);
    const connections = (await store.connections.list(account.id)).filter(
      (x) => x.state === "active",
    );
    const names = new Map<string, string>();
    const out: MissedView[] = [];
    for (const g of groups) {
      if (!names.has(g.householdId)) {
        names.set(g.householdId, (await store.getHousehold(g.householdId))?.name ?? "");
      }
      let callBack: CallBackHint | undefined;
      if (g.fromPeer.startsWith("user:")) {
        const other = await store.getUser(g.fromPeer.slice("user:".length));
        if (other && other.householdId === here && other.id !== user.id) {
          callBack = { kind: "user", userId: other.id };
        }
      } else if (g.fromPeer.startsWith("device:")) {
        const d = await store.getDevice(g.fromPeer.slice("device:".length));
        if (d?.householdId === here) callBack = { kind: "device", deviceId: d.id };
      } else if (g.fromPeer.includes("@")) {
        const conn = connections.find(
          (x) => `${x.peerHandle}@${x.peerHost || ownHost(env)}`.toLowerCase() === g.fromPeer,
        );
        if (conn) callBack = { kind: "connection", connectionId: conn.id };
      }
      out.push({
        id: g.id,
        kind: "call",
        from: g.fromLabel,
        at: g.at,
        count: g.count,
        ...(g.householdId !== here ? { space: names.get(g.householdId) ?? "" } : {}),
        ...(callBack ? { callBack } : {}),
      });
    }
    for (const m of await store.lines.missedCallbacks(account.id, 50)) {
      out.push({
        id: m.id,
        kind: "callback",
        from: m.lineName,
        at: m.at,
        count: 1,
        callBack: { kind: "line", address: m.lineAddress },
      });
    }
    out.sort((a, b) => b.at - a.at);
    return c.json({ missed: out });
  });

  /** Clears them (seen), here and on all your phones. */
  api.post("/missed/clear", async (c) => {
    const account = c.get("account");
    const calls = await store.missed.clear({ accountId: account.id }, env.now());
    const callbacks = await store.lines.clearMissedCallbacks(account.id);
    for (const m of await store.listMemberships(account.id)) {
      for (const d of await store.listDevices(m.household.id)) {
        if (d.ownerUserId === m.user.id) await live.refreshDevice(m.household.id, d.id);
      }
    }
    await live.notifyAccount(account.id, { t: "missed.changed" });
    return c.json({ cleared: calls + callbacks });
  });
}
