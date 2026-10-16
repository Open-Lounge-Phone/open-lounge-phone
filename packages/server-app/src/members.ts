// Membership of a space: its owner (and handing it on), leaving it yourself, and renaming people
// in it. Every space type: homes have an owner too (who made it), like teams and orgs.
import { leaveCheck, mayTransferOwnership } from "@openloungephone/core";
import { Id } from "@openloungephone/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { unlinkAddonsOf } from "./addons.ts";
import { auditFrom } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";
import { deleteSpace, removeMember } from "./leaving.ts";
import { dropVoicemailBlobs } from "./voicemail.ts";
import { roleOf } from "./workplace.ts";

const OwnerBody = z.object({ userId: Id });
const RenameBody = z.object({ name: z.string().trim().min(1).max(24) }).strict();

export function memberRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  /** The owner hands the space to another guardian (an admin in a team or org). */
  api.post("/space/owner", async (c) => {
    const me = c.get("user");
    const b = await body(c.req.raw, OwnerBody);
    if (b instanceof Response) return b;
    const target = await store.getUser(b.userId);
    if (!target || target.householdId !== me.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const check = mayTransferOwnership(await roleOf(env, me), await roleOf(env, target));
    if (!check.ok) return c.json({ error: check.error }, 403);
    if (!(await store.setSpaceOwner(me.householdId, target.id))) {
      return c.json({ error: "not found" }, 404);
    }
    await auditFrom(env, c, "owner.transfer", { userId: target.id, name: target.name });
    return c.body(null, 204);
  });

  /**
   * Leave the active space yourself. The owner hands it on first, unless they're alone in it
   * (then leaving deletes it, phones and all). Someone whose only space this is deletes their
   * account instead (Account → Your data).
   */
  api.post("/space/leave", async (c) => {
    const me = c.get("user");
    const account = c.get("account");
    const check = leaveCheck({
      role: await roleOf(env, me),
      members: await store.memberCount(me.householdId),
      otherSpaces: (await store.listMemberships(account.id)).length - 1,
    });
    if (!check.ok) return c.json({ error: check.error, code: check.reason }, 409);
    await auditFrom(env, c, "member.leave", { userId: me.id, name: me.name });
    await live.closeApps(me.householdId, me.id, { removed: true });
    if (check.deletesSpace) {
      await deleteSpace(env, live, me.householdId);
    } else {
      await dropVoicemailBlobs(env, { userId: me.id });
      await unlinkAddonsOf(env, live, { accountId: account.id, userId: me.id });
      await removeMember(env, live, me);
    }
    return c.json({ deletedSpace: check.deletesSpace });
  });

  /**
   * Renames someone in this space (what phones' keys and the app show): guardians (admins)
   * rename anyone here, everyone renames themselves.
   */
  api.patch("/users/:id", async (c) => {
    const me = c.get("user");
    const b = await body(c.req.raw, RenameBody);
    if (b instanceof Response) return b;
    const target = await store.getUser(c.req.param("id"));
    if (!target || target.householdId !== me.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    if (target.id !== me.id && me.role !== "guardian") {
      return c.json({ error: "guardians only" }, 403);
    }
    if (b.name === target.name) return c.body(null, 204);
    await store.renameMember(target.id, b.name);
    await auditFrom(env, c, "member.rename", { userId: target.id, from: target.name, to: b.name });
    // Phones show the new name now.
    for (const d of await store.listDevices(me.householdId)) {
      await live.refreshDevice(me.householdId, d.id);
    }
    return c.body(null, 204);
  });
}
