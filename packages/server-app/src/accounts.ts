import { validateSchedule } from "@openloungephone/core";
import {
  type Account,
  HANDLE_CHANGE_INTERVAL_MS,
  handleProblem,
  newId,
  type Session,
  SPACE_TYPES,
  type SpaceType,
  type Store,
  type User,
} from "@openloungephone/db";
import { Id, toBase64Url } from "@openloungephone/protocol";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { Connections } from "./connections.ts";
import type { ServerEnv } from "./env.ts";
import { capReached } from "./fairUse.ts";
import type { Coordinator } from "./gateway.ts";
import { body, clientIp, HOUSEHOLD_HEADER, ipBucket, relyingParty, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";
import { closeAccountApps, sessionOptions } from "./sessions.ts";

/** Households one account may be a guardian of (a cheap guard until P4's quotas). */
export const MAX_GUARDIANSHIPS_PER_ACCOUNT = 10;

const Name = z.string().trim().min(1).max(24);
const Handle = z.string().trim().toLowerCase().max(64);
const HouseholdName = z.string().trim().min(1).max(64);

const SignupOptionsBody = z.object({
  handle: Handle,
  name: Name,
  householdName: HouseholdName.optional(),
  timeZone: z.string().min(1).max(64),
  /** Cloudflare Turnstile response, required when the server has Turnstile keys. */
  turnstileToken: z.string().max(4096).optional(),
});

/** Verifies a Turnstile response with Cloudflare (siteverify). */
export async function turnstileOk(
  env: ServerEnv,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (!env.turnstile) return true;
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.turnstile.secret);
  form.append("response", token);
  if (ip !== "unknown") form.append("remoteip", ip);
  try {
    const request = new Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    const res = await (env.fetch ?? ((r: Request) => fetch(r)))(request);
    const result = (await res.json()) as { success?: boolean };
    return result.success === true;
  } catch (e) {
    env.log("warn", "turnstile check failed", { error: String(e) });
    return false;
  }
}
const SignupBody = z.object({
  challengeId: Id,
  passkeyName: z.string().trim().min(1).max(40).default("Passkey"),
  response: z.looseObject({ id: z.string() }),
});
const SignupData = z.object({
  handle: z.string(),
  name: z.string(),
  householdName: z.string(),
  timeZone: z.string(),
});
const HouseholdBody = z.object({
  name: HouseholdName,
  timeZone: z.string().min(1).max(64).optional(),
  /** `home` (default) is a family; `team` and `org` are grown-ups only. */
  type: z.enum(SPACE_TYPES as [SpaceType, ...SpaceType[]]).optional(),
});
const SwitchBody = z.object({ householdId: Id });
const AccountPatch = z
  .object({
    handle: Handle.optional(),
    name: Name.optional(),
    /** Share your availability with your connections. */
    sharePresence: z.boolean().optional(),
  })
  .refine((b) => b.handle !== undefined || b.name !== undefined || b.sharePresence !== undefined, {
    message: "nothing to change",
  });

/** The host people put after `handle@`. */
export function serverHost(env: ServerEnv, requestUrl: string): string {
  return new URL(env.publicUrl ?? requestUrl).host;
}

export function accountView(account: Account, host: string) {
  return {
    id: account.id,
    handle: account.handle,
    name: account.name,
    address: `${account.handle}@${host}`,
  };
}

function timeZoneProblem(timeZone: string): string | undefined {
  try {
    validateSchedule({ timeZone, rules: [] });
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Resolves the bearer session: sets `account`, `token` and `member` (the active membership, or
 * the one named by the `x-household` header, which must be the caller's own).
 */
export async function resolveSession(
  store: Store,
  token: string,
  householdHint: string | undefined,
  now: number,
): Promise<
  | { account: Account; member: User | undefined; session: Session }
  | "unauthorized"
  | "not_member"
  | "suspended"
> {
  const found = token ? await store.sessionForToken(token, now) : undefined;
  if (!found) return "unauthorized";
  if (found.account.suspendedAt !== null) return "suspended";
  const { account, session } = found;
  if (!householdHint) return { account, member: found.user, session };
  const member = await store.membership(account.id, householdHint);
  return member ? { account, member, session } : "not_member";
}

/** Whether this account may start a space here now (a short reason when it may not). */
export async function spaceAllowance(
  env: ServerEnv,
  account: Account,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const guardianships = await env.store.countGuardianships(account.id);
  // On an invite-only server, only people who already run a household may start another.
  if (!env.openSignup && guardianships === 0) {
    return { ok: false, error: "only guardians can add a household on this server" };
  }
  if (guardianships >= MAX_GUARDIANSHIPS_PER_ACCOUNT) {
    return { ok: false, error: "that's as many households as one account can run" };
  }
  const cap = await capReached(env, account.id, "spacesPerAccount", guardianships);
  if (cap !== undefined) {
    return { ok: false, error: `one account can run ${cap} spaces on this server (fair use)` };
  }
  return { ok: true };
}

/** Open sign-up: passkey registration creates an account and its own household. */
export function signupRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;
  const closed = () =>
    Response.json(
      { error: "sign-up is closed on this server; ask for an invite" },
      { status: 403 },
    );

  api.post("/signup/options", async (c) => {
    if (!env.openSignup) return closed();
    const b = await body(c.req.raw, SignupOptionsBody);
    if (b instanceof Response) return b;
    const now = env.now();
    // Cheap checks first, so a taken handle doesn't use up the person check (each Turnstile
    // answer works once) or an attempt.
    const problem = handleProblem(b.handle) ?? timeZoneProblem(b.timeZone);
    if (problem) return c.json({ error: problem }, 400);
    if (!(await store.handleAvailable(b.handle, now))) {
      return c.json({ error: "that handle is taken" }, 409);
    }
    const ip = clientIp(env, c);
    const limits = limitsOf(env);
    // Accounts made from here count toward the hourly limit; tries have a looser one of their own.
    const made = await store.connections.counted(await ipBucket("signup-ip", ip), 3_600_000, now);
    const tryOk = await store.connections.hit(
      await ipBucket("signup-try-ip", ip),
      3_600_000,
      limits.signupAttemptsPerIpPerHour,
      now,
    );
    if (made >= limits.signupsPerIpPerHour || !tryOk) {
      return c.json({ error: "too many sign-ups from here; try again in an hour" }, 429);
    }
    if (env.turnstile && !(await turnstileOk(env, b.turnstileToken, ip))) {
      return c.json({ error: "please complete the check that you're a person" }, 403);
    }
    const { rpID } = relyingParty(env, c.req.url);
    const host = serverHost(env, c.req.url);
    const options = await generateRegistrationOptions({
      rpName: "Open Lounge Phone",
      rpID,
      userName: `${b.handle}@${host}`,
      userDisplayName: b.name,
      userID: new TextEncoder().encode(newId("acc")),
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await store.saveChallenge(
      {
        kind: "signup",
        challenge: options.challenge,
        data: {
          handle: b.handle,
          name: b.name,
          householdName: b.householdName ?? `${b.name}'s home`.slice(0, 64),
          timeZone: b.timeZone,
        } satisfies z.infer<typeof SignupData>,
      },
      env.now(),
    );
    return c.json({ challengeId, options, address: `${b.handle}@${host}` });
  });

  api.post("/signup", async (c) => {
    if (!env.openSignup) return closed();
    const b = await body(c.req.raw, SignupBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const challenge = await store.takeChallenge(b.challengeId, "signup", now);
    const data = SignupData.safeParse(challenge?.data);
    if (!challenge || !data.success) {
      return c.json({ error: "that took too long; try again" }, 400);
    }
    const { rpID, origin } = relyingParty(env, c.req.url);
    let credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] };
    try {
      const result = await verifyRegistrationResponse({
        // biome-ignore lint/suspicious/noExplicitAny: validated by SimpleWebAuthn
        response: b.response as any,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
      });
      if (!result.verified || !result.registrationInfo) {
        return c.json({ error: "could not verify the passkey" }, 400);
      }
      credential = result.registrationInfo.credential;
    } catch (e) {
      env.log("warn", "sign-up passkey rejected", { error: String(e) });
      return c.json({ error: "could not verify the passkey" }, 400);
    }
    const { handle, name, householdName, timeZone } = data.data;
    const ip = clientIp(env, c);
    const signupBucket = await ipBucket("signup-ip", ip);
    if (
      (await store.connections.counted(signupBucket, 3_600_000, now)) >=
      limitsOf(env).signupsPerIpPerHour
    ) {
      return c.json({ error: "too many sign-ups from here; try again in an hour" }, 429);
    }
    const account = await store.createAccount({ name, handle }, now);
    if (!account) return c.json({ error: "that handle was just taken; pick another" }, 409);
    // Only accounts actually made count toward the per-IP limit.
    await store.connections.hit(signupBucket, 3_600_000, Number.MAX_SAFE_INTEGER, now);
    await store.addPasskey({
      id: credential.id,
      accountId: account.id,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: b.passkeyName,
      createdAt: now,
    });
    const { household, guardian } = await store.createHousehold(
      { name: householdName, timeZone, guardianName: name, accountId: account.id },
      now,
    );
    const token = await store.createAccountSession(
      account.id,
      guardian.id,
      now,
      sessionOptions(c, "signup", { passkey: true }),
    );
    return c.json(
      {
        token,
        user: guardian,
        household,
        account: accountView(account, serverHost(env, c.req.url)),
      },
      201,
    );
  });
}

/** Routes for a signed-in account, whether or not it has a household yet. */
export function accountRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.get("/me", async (c) => {
    const account = c.get("account");
    const user = c.get("member");
    const [household, availability, memberships] = await Promise.all([
      user ? store.getHousehold(user.householdId) : undefined,
      user ? store.availability(user.householdId) : undefined,
      store.listMemberships(account.id),
    ]);
    return c.json({
      user: user ?? null,
      household: household ?? null,
      // Whether this person is taking app-to-app calls (see presence.set).
      available: (user && availability?.get(user.id)) ?? true,
      account: accountView(account, serverHost(env, c.req.url)),
      memberships: memberships.map((m) => ({
        userId: m.user.id,
        householdId: m.household.id,
        householdName: m.household.name,
        spaceType: m.household.type,
        name: m.user.name,
        role: m.user.role,
      })),
      openSignup: env.openSignup === true,
      /** Whether "Add a household / team" works for this account on this server. */
      canAddSpace: (await spaceAllowance(env, account)).ok,
      operator: isOperator(env, account),
      sharePresence: account.sharePresence,
      recoveryCode: account.hasRecoveryCode,
      passkeys: (await store.listPasskeys(account.id)).length,
      session: sessionView(c.get("session")),
      ...(user ? { owner: (await store.spaceOwnerUser(user.householdId)) === user.id } : {}),
    });
  });

  api.post("/logout", async (c) => {
    await store.deleteSession(c.get("token"));
    // Its open app sockets close too: nothing keeps working on them.
    const id = c.get("session").id;
    if (id) await closeAccountApps(env, live, c.get("account").id, { only: [id] });
    return c.body(null, 204);
  });

  /** Makes one of the caller's households the session's default. */
  api.put("/me/household", async (c) => {
    const b = await body(c.req.raw, SwitchBody);
    if (b instanceof Response) return b;
    const member = await store.membership(c.get("account").id, b.householdId);
    if (!member) return c.json({ error: "not found" }, 404);
    await store.setSessionUser(c.get("token"), member.id);
    return c.body(null, 204);
  });

  /**
   * "Add a household" (or a team/org space, `/spaces`): the caller becomes its first guardian,
   * and it becomes active.
   */
  const addSpace = async (c: Context<Vars>) => {
    const account = c.get("account");
    const b = await body(c.req.raw, HouseholdBody);
    if (b instanceof Response) return b;
    const allowed = await spaceAllowance(env, account);
    if (!allowed.ok) return c.json({ error: allowed.error }, 403);
    const member = c.get("member");
    const current = member ? await store.getHousehold(member.householdId) : undefined;
    const timeZone = b.timeZone ?? current?.timeZone ?? "UTC";
    const problem = timeZoneProblem(timeZone);
    if (problem) return c.json({ error: problem }, 400);
    const { household, guardian } = await store.createHousehold(
      {
        name: b.name,
        timeZone,
        guardianName: member?.name ?? account.name.slice(0, 24),
        accountId: account.id,
        type: b.type ?? "home",
      },
      env.now(),
    );
    await store.setSessionUser(c.get("token"), guardian.id);
    return c.json({ household, user: guardian }, 201);
  };
  api.post("/households", addSpace);
  api.post("/spaces", addSpace);

  /** Change your handle (at most once a day) and/or display name. */
  api.patch("/account", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, AccountPatch);
    if (b instanceof Response) return b;
    const now = env.now();
    if (b.handle !== undefined && b.handle !== account.handle) {
      const problem = handleProblem(b.handle);
      if (problem) return c.json({ error: problem }, 400);
      if (
        account.handleChangedAt !== null &&
        now - account.handleChangedAt < HANDLE_CHANGE_INTERVAL_MS
      ) {
        return c.json({ error: "you can change your handle once a day" }, 429);
      }
      if (!(await store.setHandle(account.id, b.handle, now))) {
        return c.json({ error: "that handle is taken" }, 409);
      }
      // Timelines here keep following this person under the new address.
      const host = serverHost(env, c.req.url);
      await store.renamePeer(`${account.handle}@${host}`, `${b.handle}@${host}`);
    }
    if (b.name !== undefined) await store.setAccountName(account.id, b.name);
    if (b.sharePresence !== undefined && b.sharePresence !== account.sharePresence) {
      const presence = new Connections(env, live);
      const available = c.get("member")
        ? ((await store.availability(c.get("member")?.householdId as string)).get(
            c.get("member")?.id as string,
          ) ?? true)
        : true;
      // Turning it off says "offline" once; turning it on shares where you are now (online).
      if (!b.sharePresence) await presence.publishPresence(account.id, false, false);
      await store.setSharePresence(account.id, b.sharePresence);
      if (b.sharePresence) await presence.publishPresence(account.id, true, available);
    }
    const updated = (await store.getAccount(account.id)) as Account;
    return c.json({
      ...accountView(updated, serverHost(env, c.req.url)),
      sharePresence: updated.sharePresence,
    });
  });
}

/**
 * Whether an account runs this server: `OPERATORS` lists account ids (`acc_…`), never handles,
 * so a renamed, released or re-registered handle never carries operator rights.
 */
export const isOperator = (env: ServerEnv, account: Account) =>
  (env.operators ?? []).some((id) => id.startsWith("acc_") && id === account.id);

/**
 * What's wrong with an `OPERATORS` list (for the host to log at startup): handles, which give
 * no rights (with the account id to use instead), and ids of no account here.
 */
export async function operatorProblems(store: Store, operators: string[]): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of operators) {
    if (entry.startsWith("acc_")) {
      if (!(await store.getAccount(entry))) {
        problems.push(`OPERATORS: no account ${entry} on this server`);
      }
      continue;
    }
    const account = await store.accountByHandle(entry.replace(/^@/, "").replace(/@.*$/, ""));
    problems.push(
      account
        ? `OPERATORS: "${entry}" is a handle, which gives no operator rights (handles can change hands). Use the account id instead: OPERATORS=${account.id}`
        : `OPERATORS: "${entry}" is not an account id (acc_…); it gives no operator rights`,
    );
  }
  return problems;
}

/** What the app needs to know about its own session (never the token). */
export function sessionView(s: Session) {
  return {
    id: s.id,
    via: s.via,
    passkey: s.passkey,
    limited: s.limited,
    expiresAt: s.expiresAt,
  };
}

/** Reads the household hint a companion sends with each request. */
export const householdHint = (header: (name: string) => string | undefined) =>
  header(HOUSEHOLD_HEADER) || undefined;
