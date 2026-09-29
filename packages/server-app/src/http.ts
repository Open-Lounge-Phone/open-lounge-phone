import {
  deviceFingerprint,
  type QuietHoursRule,
  validateSchedule,
  type Weekday,
} from "@openloungephone/core";
import {
  deviceMode,
  type HouseLineKey,
  isRemoteContactId,
  LOUNGE_SESSION_POLICIES,
  type LoungeSessionPolicy,
  newToken,
  type PhoneMode,
  RETENTION_DAYS,
  retentionName,
  sha256,
  type User,
} from "@openloungephone/db";
import { Id } from "@openloungephone/protocol";
import { Hono } from "hono";
import { z } from "zod";
import {
  accountRoutes,
  accountView,
  householdHint,
  resolveSession,
  serverHost,
  signupRoutes,
} from "./accounts.ts";
import { Connections, connectionRoutes } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { capReached } from "./fairUse.ts";
import { FederationError, fedFetch, ownHost } from "./federation.ts";
import type { Coordinator } from "./gateway.ts";
import { body, guardianOnly, type Vars } from "./httpUtil.ts";
import { hubRoutes, publicHubRoutes } from "./hubAdmin.ts";
import { leavingRoutes } from "./leaving.ts";
import { limitsOf } from "./limits.ts";
import { peopleRoutes, publicPeopleRoutes } from "./people.ts";
import { sweepSpace, timelineRoutes } from "./timeline.ts";
import { publicVoicemailRoutes } from "./vmTickets.ts";
import { dropVoicemailBlobs, voicemailRoutes } from "./voicemail.ts";

/** Settings key holding the hash of the one-time first-run setup token. */
export const SETUP_TOKEN_KEY = "setup_token_hash";

const Name = z.string().trim().min(1).max(24);

const SetupBody = z.object({
  token: z.string().min(1),
  householdName: z.string().trim().min(1).max(64),
  guardianName: Name,
  timeZone: z.string().min(1),
});
const Code = z.string().regex(/^\d{6}$/);
const Mode = z.enum(["kids", "personal", "lounge"]);
const PairBody = z.object({
  code: Code,
  name: Name,
  /**
   * How the phone will be used: `kids` (a home's phone for a child; guardians), `personal` (the
   * caller's own phone; any member) or `lounge` (the space's shared phone; guardians). Default:
   * what the phone was set up as.
   */
  mode: Mode.optional(),
  /** Older apps: pair as the caller's own phone (= `mode: "personal"`). */
  forMe: z.boolean().optional(),
  /** Older apps: `kids` or `lounge` (= `mode`). */
  kind: z.enum(["kids", "lounge"]).optional(),
});
/** A space's retention default: 30 days, a year, or forever (no expiry). */
const SpaceRetention = z.enum(["30d", "1y", "forever"]);
const PrivacyBody = z
  .object({
    history: SpaceRetention.optional(),
    voicemail: SpaceRetention.optional(),
    transcription: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to change" });
const spaceDays = (r: z.infer<typeof SpaceRetention>) =>
  r === "forever" ? null : RETENTION_DAYS[r];

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
const HouseLineKeyBody = z.object({
  index: z.number().int().min(0).max(9),
  label: Name,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("user"), userId: Id }),
    z.object({ kind: z.literal("device"), deviceId: Id }),
    z.object({ kind: z.literal("group"), userIds: z.array(Id).min(1).max(10) }),
  ]),
});
const LoungeSettingsBody = z
  .object({
    idleMinutes: z.number().int().min(1).max(240).optional(),
    /** Let people from other servers use this space's Lounge phones (their server vouches). */
    guests: z.boolean().optional(),
    /** How long a session lasts: idle minutes, until the end of the day, or until logout. */
    session: z.enum(LOUNGE_SESSION_POLICIES as [LoungeSessionPolicy]).optional(),
    /** `end_of_day`: local time the day ends. */
    dayEnd: HHMM.optional(),
    /** Idle phones (nobody signed in): keys that call as the space. Off by default. */
    houseLine: z
      .object({ enabled: z.boolean(), keys: z.array(HouseLineKeyBody).max(10) })
      .optional(),
    /** Idle phones show who's signed in at the space's other Lounge phones, open to chat. */
    whosHere: z.boolean().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "nothing to change",
  });
const RemoteLoungeBody = z.object({
  host: z.string().trim().toLowerCase().min(1).max(260),
  deviceId: Id,
  nonce: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,64}$/)
    .optional(),
});
const DevicePatch = z
  .object({ name: Name.optional(), owner: z.enum(["me", "household"]).optional() })
  .refine((b) => b.name !== undefined || b.owner !== undefined, { message: "nothing to change" });
const ContactBody = z.object({
  label: Name,
  canCallDevice: z.boolean(),
  deviceCanCall: z.boolean(),
  bypassQuietHours: z.boolean(),
});
const ButtonBody = z.object({ userId: Id.nullable() });
const QuietBody = z.object({
  rules: z
    .array(
      z.object({
        days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
        start: z.string(),
        end: z.string(),
      }),
    )
    .max(32),
});

/**
 * On an instance with no households, makes sure a one-time setup token exists. Returns the new
 * token so the host can print a setup link, or undefined if setup is done or already pending.
 */
export async function ensureSetupToken(env: ServerEnv): Promise<string | undefined> {
  // Instances without a startup hook (Cloudflare) seed the hash at deploy time instead.
  if ((await env.store.countHouseholds()) > 0) return undefined;
  const token = newToken();
  await env.store.setSetting(SETUP_TOKEN_KEY, await sha256(token));
  return token;
}

/**
 * For hosts without a startup hook (Cloudflare): accepts a deploy-time secret as the setup token
 * until the first household exists.
 */
export async function seedSetupToken(env: ServerEnv, token: string): Promise<void> {
  if (!token || (await env.store.countHouseholds()) > 0) return;
  if (await env.store.getSetting(SETUP_TOKEN_KEY)) return;
  await env.store.setSetting(SETUP_TOKEN_KEY, await sha256(token));
}

/** REST API mounted at `/api`. Transports add the WebSocket routes and static files. */
export function createApi(env: ServerEnv, live: Coordinator): Hono<Vars> {
  const { store } = env;
  const api = new Hono<Vars>();

  api.get("/health", (c) => c.json({ ok: true }));

  // --- first-run setup ------------------------------------------------------

  // `signup`: the server has open sign-up, so the companion offers "Create an account".
  api.get("/setup", async (c) =>
    c.json({
      needed: (await store.countHouseholds()) === 0,
      signup: env.openSignup === true,
      // Cloudflare Turnstile on sign-up (public hubs); absent = no check.
      ...(env.turnstile ? { turnstileSiteKey: env.turnstile.siteKey } : {}),
    }),
  );

  api.post("/setup", async (c) => {
    const b = await body(c.req.raw, SetupBody);
    if (b instanceof Response) return b;
    const expected = await store.getSetting(SETUP_TOKEN_KEY);
    if (!expected || (await sha256(b.token)) !== expected) {
      return c.json({ error: "invalid or used setup token" }, 403);
    }
    try {
      validateSchedule({ timeZone: b.timeZone, rules: [] });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    await store.setSetting(SETUP_TOKEN_KEY, null);
    const now = env.now();
    const { household, guardian } = await store.createHousehold(
      { name: b.householdName, timeZone: b.timeZone, guardianName: b.guardianName },
      now,
    );
    const token = await store.createSession(guardian.id, now);
    const account = await store.getAccount(guardian.accountId);
    return c.json(
      {
        token,
        user: guardian,
        household,
        ...(account ? { account: accountView(account, serverHost(env, c.req.url)) } : {}),
      },
      201,
    );
  });

  signupRoutes(api, env);
  publicPeopleRoutes(api, env);
  publicHubRoutes(api, env);
  publicVoicemailRoutes(api, env, live);

  // --- authenticated --------------------------------------------------------

  api.use("/*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = await resolveSession(
      store,
      token,
      householdHint((n) => c.req.header(n)),
      env.now(),
    );
    if (session === "unauthorized") return c.json({ error: "unauthorized" }, 401);
    if (session === "suspended") return c.json({ error: "this account is suspended" }, 403);
    if (session === "not_member") return c.json({ error: "not a member of that household" }, 403);
    // A fair per-account pace for changes (reads are free).
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const perMinute = limitsOf(env).writesPerAccountPerMinute;
      if (
        !(await store.connections.hit(`writes:${session.account.id}`, 60_000, perMinute, env.now()))
      ) {
        return c.json({ error: "slow down" }, 429, { "retry-after": "60" });
      }
    }
    c.set("account", session.account);
    c.set("member", session.member);
    c.set("token", token);
    await next();
  });

  accountRoutes(api, env, live);
  hubRoutes(api, env);
  leavingRoutes(api, env, live);
  connectionRoutes(api, env, live);
  timelineRoutes(api, env);

  // Everything below acts inside the active household.
  api.use("/*", async (c, next) => {
    const member = c.get("member");
    if (!member) return c.json({ error: "you're not in a household yet" }, 403);
    c.set("user", member);
    await next();
  });

  const kidsOnlyAtHome =
    "kids' phones belong in a home space; pair it as your own or a Lounge phone";
  const isHome = async (householdId: string) =>
    (await store.getHousehold(householdId))?.type === "home";

  /** Loads a device and ensures it belongs to the caller's household. */
  const ownDevice = async (user: User, id: string) => {
    const device = await store.getDevice(id);
    return device && device.householdId === user.householdId ? device : undefined;
  };

  /** A phone the caller may configure: any household phone for guardians, or their own phone. */
  const manageable = async (user: User, id: string) => {
    const device = await ownDevice(user, id);
    if (!device) return undefined;
    return user.role === "guardian" || device.ownerUserId === user.id ? device : undefined;
  };

  api.get("/users", async (c) => c.json(await store.listUsers(c.get("user").householdId)));

  api.get("/devices", async (c) => {
    const user = c.get("user");
    const devices = await store.listDevices(user.householdId);
    return c.json(
      await Promise.all(
        devices.map(async (d) => ({
          id: d.id,
          name: d.name,
          online: await live.isOnline(user.householdId, d.id),
          lastSeen: d.lastSeen,
          ownerUserId: d.ownerUserId,
          kind: d.kind,
          mode: deviceMode(d),
          // For the phone's page: what it runs, and the four words its MENU → About shows.
          fw: d.fw,
          model: d.model,
          fingerprint: await deviceFingerprint(d.publicKey),
          contact: (await store.getContact(d.id, user.id)) ?? null,
        })),
      ),
    );
  });

  /**
   * Before claiming: what the phone was set up as. (The four-word fingerprint to compare with
   * the phone's MENU → About comes with it; see security-model.md.)
   */
  api.post("/devices/pair/preview", async (c) => {
    const b = await body(c.req.raw, z.object({ code: Code }));
    if (b instanceof Response) return b;
    const pending = await store.peekPairing(b.code, env.now());
    if (!pending) return c.json({ error: "unknown or expired code" }, 404);
    // "Check these words match": the phone shows the same four under MENU → About.
    return c.json({ mode: pending.mode, fingerprint: await deviceFingerprint(pending.publicKey) });
  });

  api.post("/devices/pair", async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, PairBody);
    if (b instanceof Response) return b;
    if (b.forMe && b.kind === "lounge") {
      return c.json({ error: "a Lounge phone is shared; pair it as a household phone" }, 400);
    }
    const chosen = b.mode ?? (b.forMe ? "personal" : b.kind);
    const mode: PhoneMode = chosen ?? (await store.peekPairing(b.code, env.now()))?.mode ?? "kids";
    if (mode !== "personal" && user.role !== "guardian") {
      return c.json({ error: "only guardians can add household phones" }, 403);
    }
    if (mode === "kids" && !(await isHome(user.householdId))) {
      // A household phone without an owner is a kid's phone; those belong in a home.
      return c.json({ error: kidsOnlyAtHome }, 400);
    }
    const phones = (await store.listDevices(user.householdId)).length;
    const owner = await store.spaceOwner(user.householdId);
    const cap = await capReached(env, owner, "phonesPerSpace", phones);
    if (cap !== undefined) {
      return c.json({ error: `a space can have ${cap} phones on this server (fair use)` }, 403);
    }
    const device = await store.claimPairing(
      {
        code: b.code,
        householdId: user.householdId,
        name: b.name,
        ownerUserId: mode === "personal" ? user.id : null,
        kind: mode === "lounge" ? "lounge" : "kids",
      },
      env.now(),
    );
    if (!device) return c.json({ error: "unknown or expired code" }, 404);
    if (device.kind === "lounge") {
      // No allow-list of its own: whoever takes it over brings their own permissions.
    } else if (mode === "personal") {
      // A grown-up's own phone: everyone else in the household on its speed-dial keys.
      const others = (await store.listUsers(user.householdId)).filter((u) => u.id !== user.id);
      for (const [i, other] of others.slice(0, 10).entries()) {
        await store.upsertContact(device.id, {
          id: other.id,
          label: other.name,
          canCallDevice: true,
          deviceCanCall: true,
          bypassQuietHours: true,
        });
        await store.setButton(device.id, i, other.id);
      }
    } else {
      // The guardian who paired the phone is its first contact, on the first button.
      await store.upsertContact(device.id, {
        id: user.id,
        label: user.name,
        canCallDevice: true,
        deviceCanCall: true,
        bypassQuietHours: true,
      });
      await store.setButton(device.id, 0, user.id);
    }
    await live.notifyPaired(b.code, device);
    return c.json(
      {
        id: device.id,
        name: device.name,
        mode,
        fingerprint: await deviceFingerprint(device.publicKey),
      },
      201,
    );
  });

  api.get("/devices/:id/contacts", async (c) => {
    const device = await manageable(c.get("user"), c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const [contacts, buttons, remote] = await Promise.all([
      store.listContacts(device.id),
      store.listButtons(device.id),
      store.listRemoteContacts(device.id),
    ]);
    const host = ownHost(env, c.req.url);
    return c.json({
      contacts,
      buttons: Object.fromEntries(buttons),
      // Entries from connections (other households or servers): `rc_…` ids in `contacts`.
      remote: remote.map((r) => ({
        id: r.id,
        connectionId: r.connectionId,
        address: `${r.connection.peerHandle}@${r.connection.peerHost || host}`,
        name: r.connection.peerName,
      })),
    });
  });

  /**
   * Puts one of your own active connections on a phone's allow-list (a person from another
   * household or server). Default-deny still holds: they can call only with `canCallDevice`, and
   * the entry goes away when the connection does.
   */
  api.put("/devices/:id/remote-contacts/:connectionId", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    if (!device || device.kind === "lounge") return c.json({ error: "not found" }, 404);
    const connection = await store.connections.get(c.req.param("connectionId"));
    if (!connection || connection.accountId !== c.get("account").id) {
      return c.json({ error: "not found" }, 404);
    }
    if (connection.state !== "active") {
      return c.json({ error: "only people you're connected with can be added" }, 409);
    }
    const b = await body(c.req.raw, ContactBody);
    if (b instanceof Response) return b;
    const id = await store.upsertRemoteContact(device.id, connection.id, b);
    await live.refreshDevice(user.householdId, device.id);
    // They see (or stop seeing) this phone among the ones they may call.
    await new Connections(env, live).sharePhones(connection.id);
    return c.json({ id });
  });

  api.put("/devices/:id/contacts/:userId", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    const target = await store.getUser(c.req.param("userId"));
    if (!device || !target || target.householdId !== user.householdId) {
      return c.json({ error: "not found" }, 404);
    }
    const b = await body(c.req.raw, ContactBody);
    if (b instanceof Response) return b;
    await store.upsertContact(device.id, { id: target.id, ...b });
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.delete("/devices/:id/contacts/:userId", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const id = c.req.param("userId");
    const via = isRemoteContactId(id)
      ? (await store.listRemoteContacts(device.id)).find((r) => r.id === id)?.connectionId
      : undefined;
    await store.removeContact(device.id, id);
    await live.refreshDevice(user.householdId, device.id);
    if (via) await new Connections(env, live).sharePhones(via);
    return c.body(null, 204);
  });

  /** Rename a phone and/or make it someone's own phone (or a household phone again). */
  api.patch("/devices/:id", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    const b = await body(c.req.raw, DevicePatch);
    if (b instanceof Response) return b;
    if (b.owner === "me" && device.kind === "lounge") {
      return c.json({ error: "a Lounge phone can't be someone's own phone" }, 400);
    }
    if (b.owner === "household" && device.kind !== "lounge" && !(await isHome(user.householdId))) {
      return c.json({ error: kidsOnlyAtHome }, 400);
    }
    if (b.owner !== undefined) {
      // You can claim a phone for yourself or release your own; guardians can also release any.
      const allowed =
        (b.owner === "me" && (user.role === "guardian" || device.ownerUserId === user.id)) ||
        (b.owner === "household" && (user.role === "guardian" || device.ownerUserId === user.id));
      if (!allowed) return c.json({ error: "not allowed" }, 403);
    }
    await store.updateDevice(device.id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.owner === "me" ? { ownerUserId: user.id } : {}),
      ...(b.owner === "household" ? { ownerUserId: null } : {}),
    });
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.delete("/devices/:id", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    if (!device) return c.json({ error: "not found" }, 404);
    // Voicemail and greeting rows cascade with the phone; their audio lives in the blob store.
    await dropVoicemailBlobs(env, { deviceId: device.id });
    const shared = (await store.listRemoteContacts(device.id)).map((r) => r.connectionId);
    // Remove = wipe: the phone is told now (if connected) or when it next connects.
    await store.recordRemovedDevices([device], env.now());
    await store.deleteDevice(device.id);
    await live.forgetDevice(user.householdId, device.id);
    for (const id of shared) await new Connections(env, live).sharePhones(id);
    return c.body(null, 204);
  });

  api.put("/devices/:id/buttons/:index", async (c) => {
    const user = c.get("user");
    const device = await manageable(user, c.req.param("id"));
    const index = Number(c.req.param("index"));
    if (!device) return c.json({ error: "not found" }, 404);
    if (!Number.isInteger(index) || index < 0 || index > 15) {
      return c.json({ error: "index must be 0-15" }, 400);
    }
    const b = await body(c.req.raw, ButtonBody);
    if (b instanceof Response) return b;
    if (b.userId !== null && !(await store.getContact(device.id, b.userId))) {
      return c.json({ error: "add the person to the allow-list first" }, 400);
    }
    await store.setButton(device.id, index, b.userId);
    await live.refreshDevice(user.householdId, device.id);
    return c.body(null, 204);
  });

  api.get("/quiet-hours", async (c) => c.json(await store.getSchedule(c.get("user").householdId)));

  api.put("/quiet-hours", guardianOnly, async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, QuietBody);
    if (b instanceof Response) return b;
    const household = await store.getHousehold(user.householdId);
    if (household?.type !== "home") {
      return c.json({ error: "quiet hours are for kids' phones in a home space" }, 400);
    }
    const rules: QuietHoursRule[] = b.rules.map((r) => ({ ...r, days: r.days as Weekday[] }));
    try {
      validateSchedule({ timeZone: household?.timeZone ?? "UTC", rules });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    await store.setQuietRules(user.householdId, rules);
    for (const d of await store.listDevices(user.householdId)) {
      await live.refreshDevice(user.householdId, d.id);
    }
    return c.body(null, 204);
  });

  // --- privacy: retention defaults and transcription ---------------------------

  /** How long this space keeps history and voicemail, and whether voicemail is transcribed. */
  api.get("/space/privacy", async (c) => {
    const p = await store.spacePrivacy(c.get("user").householdId);
    return c.json({
      history: retentionName(p.historyDays ?? 0),
      voicemail: retentionName(p.voicemailDays ?? 0),
      transcription: p.transcribe,
      // Whether this server can transcribe at all.
      transcriber: !!env.transcriber,
    });
  });

  api.put("/space/privacy", guardianOnly, async (c) => {
    const b = await body(c.req.raw, PrivacyBody);
    if (b instanceof Response) return b;
    const hh = c.get("user").householdId;
    await store.setSpacePrivacy(hh, {
      ...(b.history ? { historyDays: spaceDays(b.history) } : {}),
      ...(b.voicemail ? { voicemailDays: spaceDays(b.voicemail) } : {}),
      ...(b.transcription !== undefined ? { transcribe: b.transcription } : {}),
    });
    await sweepSpace(env, hh);
    return c.body(null, 204);
  });

  // --- Lounge phones --------------------------------------------------------

  /** Lounge phones and who is at them; guardians also get the settings and session history. */
  api.get("/lounge", async (c) => {
    const user = c.get("user");
    const hh = user.householdId;
    const [devices, sessions, users, settings] = await Promise.all([
      store.listDevices(hh),
      store.listLoungeSessions(hh, 50),
      store.listUsers(hh),
      store.loungeSettings(hh),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const phones = await Promise.all(
      devices
        .filter((d) => d.kind === "lounge")
        .map(async (d) => {
          const open = sessions.find((s) => s.deviceId === d.id && s.endedAt === null);
          return {
            id: d.id,
            name: d.name,
            online: await live.isOnline(hh, d.id),
            session: open
              ? {
                  userId: open.userId,
                  name: open.guest?.name ?? nameOf.get(open.userId ?? "") ?? "",
                  since: open.startedAt,
                  ...(open.guest ? { guest: open.guest.address } : {}),
                }
              : null,
          };
        }),
    );
    const guardian = user.role === "guardian";
    return c.json({
      idleMinutes: settings.idleMinutes,
      guests: settings.guests,
      session: settings.session,
      dayEnd: settings.dayEnd,
      // What idle phones offer (house-line keys, who's here); only guardians manage it.
      ...(guardian ? { idle: settings.idle } : {}),
      phones,
      // Only that a session happened: who, where, when. Nothing about calls.
      ...(guardian
        ? {
            history: sessions.map((s) => ({
              deviceId: s.deviceId,
              userId: s.userId,
              userName: s.guest?.name ?? nameOf.get(s.userId ?? "") ?? "",
              ...(s.guest ? { guest: s.guest.address } : {}),
              startedAt: s.startedAt,
              endedAt: s.endedAt,
              endReason: s.endReason,
            })),
          }
        : {}),
    });
  });

  api.put("/lounge/settings", guardianOnly, async (c) => {
    const b = await body(c.req.raw, LoungeSettingsBody);
    if (b instanceof Response) return b;
    const hh = c.get("user").householdId;
    let idle: Parameters<typeof store.setLoungeSession>[1]["idle"];
    if (b.houseLine !== undefined || b.whosHere !== undefined) {
      const current = (await store.loungeSettings(hh)).idle;
      if (b.houseLine) {
        const problem = await houseLineProblem(hh, b.houseLine.keys);
        if (problem) return c.json({ error: problem }, 400);
      }
      idle = {
        houseLine: b.houseLine ?? current.houseLine,
        whosHere: b.whosHere ?? current.whosHere,
      };
    }
    if (b.idleMinutes !== undefined) await store.setLoungeIdleMinutes(hh, b.idleMinutes);
    if (b.guests !== undefined) await store.setLoungeGuests(hh, b.guests);
    await store.setLoungeSession(hh, {
      ...(b.session ? { session: b.session } : {}),
      ...(b.dayEnd ? { dayEnd: b.dayEnd } : {}),
      ...(idle ? { idle } : {}),
    });
    // Lounge phones pick up the new session policy and idle keys right away.
    for (const d of await store.listDevices(hh)) {
      if (d.kind === "lounge") await live.refreshDevice(hh, d.id);
    }
    return c.body(null, 204);
  });

  /**
   * House-line keys must point inside the space: its members, or a personal (desk) phone here.
   * Kids' phones are never a target (they have their own allow-lists).
   */
  const houseLineProblem = async (
    hh: string,
    keys: HouseLineKey[],
  ): Promise<string | undefined> => {
    if (new Set(keys.map((k) => k.index)).size !== keys.length) return "one target per key";
    const members = new Set((await store.listUsers(hh)).map((u) => u.id));
    for (const k of keys) {
      const t = k.target;
      if (t.kind === "user" && !members.has(t.userId)) return `key ${k.index}: not a member here`;
      if (t.kind === "group" && !t.userIds.every((u) => members.has(u))) {
        return `key ${k.index}: not all members here`;
      }
      if (t.kind === "device") {
        const d = await store.getDevice(t.deviceId);
        if (!d || d.householdId !== hh || deviceMode(d) !== "personal") {
          return `key ${k.index}: pick someone's own (desk) phone in this space`;
        }
      }
    }
    return undefined;
  };

  /**
   * Use a Lounge phone on another server as yourself: this server vouches for you there (a
   * signed request) and hands over your speed-dial (your connections). The phone then asks for
   * the key press, exactly as for its own members.
   */
  api.post("/lounge/remote", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, RemoteLoungeBody);
    if (b instanceof Response) return b;
    if (!b.nonce) return c.json({ error: "scan the phone's code again" }, 400);
    const now = env.now();
    const host = ownHost(env, c.req.url);
    const directory = (await store.connections.list(account.id))
      .filter((x) => x.state === "active" && x.peerAccount)
      .slice(0, 10)
      .map((x) => ({
        address: `${x.peerHandle}@${x.peerHost || host}`,
        name: (x.peerName || x.peerHandle).slice(0, 64),
      }));
    await store.startLoungeAway(account.id, b.host, b.deviceId, now);
    try {
      const res = await fedFetch(env, b.host, "/lounge/claim", {
        json: {
          from: { handle: account.handle, id: account.id, name: account.name },
          deviceId: b.deviceId,
          nonce: b.nonce,
          directory,
        },
      });
      // A refused claim leaves the record pending: only the phone's "started" makes it active.
      const result = (await res.json()) as { step: string; reason?: string; expiresAt?: number };
      return c.json({ ...result, deviceId: b.deviceId, host: b.host });
    } catch (e) {
      if (e instanceof FederationError) return c.json({ error: e.message }, e.status as 400);
      throw e;
    }
  });

  /** Leave another server's Lounge phone. */
  api.post("/lounge/remote/leave", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, RemoteLoungeBody);
    if (b instanceof Response) return b;
    await store.setLoungeAway(account.id, b.host, b.deviceId, "ended", env.now());
    try {
      await fedFetch(env, b.host, "/lounge/leave", {
        json: {
          from: { handle: account.handle, id: account.id, name: account.name },
          deviceId: b.deviceId,
        },
      });
    } catch (e) {
      env.log("warn", "lounge: leave not delivered", { error: String(e) });
    }
    return c.body(null, 204);
  });

  peopleRoutes(api, env, live);
  voicemailRoutes(api, env, live);

  return api;
}
