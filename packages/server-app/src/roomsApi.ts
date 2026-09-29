// Rooms in the companion: a space's party lines and phone rooms, and rooms on phones' keys.
//
// - Party lines: always-open rooms of the space (no address). Guardians make them.
// - Phone rooms: a name with an address `handle@host` (handles are shared with people's), made by
//   any member, who then hosts it. Open to the space, or also to the owner's connections.
// - A room goes on a phone's allow-list (and a key) only through its guardians (or its owner, for
//   a personal phone), and only rooms of the phone's own space: a kids' phone can only join rooms
//   a guardian allowed.
import { handleProblem, type Room, type User } from "@openloungephone/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, type Vars } from "./httpUtil.ts";

/** Most rooms a space may have. */
export const ROOMS_PER_SPACE = 20;

const Name = z.string().trim().min(1).max(40);
const CreateRoom = z.object({
  kind: z.enum(["party", "phone"]),
  name: Name,
  handle: z.string().trim().toLowerCase().optional(),
  access: z.enum(["space", "connections"]).optional(),
});
const PatchRoom = z
  .object({
    name: Name.optional(),
    access: z.enum(["space", "connections"]).optional(),
    locked: z.boolean().optional(),
  })
  .strict();
const PhoneRoom = z.object({ label: z.string().trim().min(1).max(24) });

export function roomRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  const mayManage = (user: User, accountId: string, room: Room) =>
    user.role === "guardian" || room.ownerAccount === accountId;

  const view = (room: Room, host: string, people: string[], mine: boolean) => ({
    id: room.id,
    kind: room.kind,
    name: room.name,
    ...(room.handle ? { address: `${room.handle}@${host}` } : {}),
    access: room.access,
    locked: room.locked,
    mine,
    people,
  });

  /** The space's rooms, who's in each right now, and how their audio travels here. */
  api.get("/rooms", async (c) => {
    const user = c.get("user");
    const account = c.get("account");
    const [rooms, people] = await Promise.all([
      store.rooms.list(user.householdId),
      live.roomPeople(user.householdId).catch(() => ({}) as Record<string, string[]>),
    ]);
    const host = ownHost(env, c.req.url);
    const relay = env.relay?.kind;
    return c.json({
      rooms: rooms.map((r) => view(r, host, people[r.id] ?? [], mayManage(user, account.id, r))),
      // How rooms carry audio on this server (for honest labelling in the app).
      media: relay === "cloudflare" ? "sfu" : relay === "livekit" ? "livekit" : "mesh",
    });
  });

  api.post("/rooms", async (c) => {
    const user = c.get("user");
    const account = c.get("account");
    const b = await body(c.req.raw, CreateRoom);
    if (b instanceof Response) return b;
    if (b.kind === "party" && user.role !== "guardian") {
      return c.json({ error: "guardians make party lines" }, 403);
    }
    if ((await store.rooms.list(user.householdId)).length >= ROOMS_PER_SPACE) {
      return c.json({ error: `a space can have ${ROOMS_PER_SPACE} rooms` }, 400);
    }
    let handle: string | null = null;
    if (b.kind === "phone") {
      if (!b.handle) return c.json({ error: "a phone room needs a name for its address" }, 400);
      const problem = handleProblem(b.handle);
      if (problem) return c.json({ error: problem }, 400);
      if (!(await store.handleAvailable(b.handle, env.now()))) {
        return c.json({ error: "that address is taken" }, 409);
      }
      handle = b.handle;
    }
    const room = await store.rooms.create(
      {
        householdId: user.householdId,
        kind: b.kind,
        name: b.name,
        handle,
        ownerAccount: account.id,
        // Party lines are the space's own.
        access: b.kind === "party" ? "space" : (b.access ?? "space"),
      },
      env.now(),
    );
    if (!room) return c.json({ error: "that address is taken" }, 409);
    return c.json(view(room, ownHost(env, c.req.url), [], true), 201);
  });

  api.patch("/rooms/:id", async (c) => {
    const user = c.get("user");
    const room = await store.rooms.get(c.req.param("id"));
    if (!room || room.householdId !== user.householdId) return c.json({ error: "not found" }, 404);
    if (!mayManage(user, c.get("account").id, room)) return c.json({ error: "not allowed" }, 403);
    const b = await body(c.req.raw, PatchRoom);
    if (b instanceof Response) return b;
    if (room.kind === "party" && b.access === "connections") {
      return c.json({ error: "a party line is for its space" }, 400);
    }
    await store.rooms.update(room.id, b);
    return c.body(null, 204);
  });

  api.delete("/rooms/:id", async (c) => {
    const user = c.get("user");
    const room = await store.rooms.get(c.req.param("id"));
    if (!room || room.householdId !== user.householdId) return c.json({ error: "not found" }, 404);
    if (!mayManage(user, c.get("account").id, room)) return c.json({ error: "not allowed" }, 403);
    const phones = (await store.listDevices(user.householdId)).map((d) => d.id);
    await live.closeRoom(user.householdId, room.id);
    await store.rooms.delete(room.id);
    for (const id of phones) await live.refreshDevice(user.householdId, id);
    return c.body(null, 204);
  });

  /** A phone you manage, in this space, that isn't a Lounge phone. */
  const phone = async (user: User, id: string) => {
    const d = await store.getDevice(id);
    if (!d || d.householdId !== user.householdId || d.kind === "lounge") return undefined;
    return user.role === "guardian" || d.ownerUserId === user.id ? d : undefined;
  };

  /** Puts a room of this space on a phone's allow-list; answers its `rk_…` id for a key. */
  api.put("/devices/:id/rooms/:roomId", async (c) => {
    const user = c.get("user");
    const device = await phone(user, c.req.param("id"));
    const room = await store.rooms.get(c.req.param("roomId"));
    if (!device || !room || room.householdId !== user.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const b = await body(c.req.raw, PhoneRoom);
    if (b instanceof Response) return b;
    const id = await store.rooms.addToPhone(device.id, room.id, b.label);
    await live.refreshDevice(user.householdId, device.id);
    return c.json({ id });
  });

  api.delete("/devices/:id/rooms/:contactId", async (c) => {
    const user = c.get("user");
    const device = await phone(user, c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    await store.rooms.removeFromPhone(device.id, c.req.param("contactId"));
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });
}
