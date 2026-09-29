import { validateSchedule } from "@openloungephone/core";
import {
  type Account,
  HANDLE_CHANGE_INTERVAL_MS,
  handleProblem,
  newId,
  type Store,
  type User,
} from "@openloungephone/db";
import { Id, toBase64Url } from "@openloungephone/protocol";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { body, HOUSEHOLD_HEADER, relyingParty, type Vars } from "./httpUtil.ts";

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
});
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
});
const SwitchBody = z.object({ householdId: Id });
const AccountPatch = z
  .object({ handle: Handle.optional(), name: Name.optional() })
  .refine((b) => b.handle !== undefined || b.name !== undefined, { message: "nothing to change" });

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
): Promise<{ account: Account; member: User | undefined } | "unauthorized" | "not_member"> {
  const session = token ? await store.sessionForToken(token, now) : undefined;
  if (!session) return "unauthorized";
  if (!householdHint) return { account: session.account, member: session.user };
  const member = await store.membership(session.account.id, householdHint);
  return member ? { account: session.account, member } : "not_member";
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
    const problem = handleProblem(b.handle) ?? timeZoneProblem(b.timeZone);
    if (problem) return c.json({ error: problem }, 400);
    if (await store.accountByHandle(b.handle)) {
      return c.json({ error: "that handle is taken" }, 409);
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
    const account = await store.createAccount({ name, handle }, now);
    if (!account) return c.json({ error: "that handle was just taken; pick another" }, 409);
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
    const token = await store.createAccountSession(account.id, guardian.id, now);
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
export function accountRoutes(api: Hono<Vars>, env: ServerEnv): void {
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
        name: m.user.name,
        role: m.user.role,
      })),
      openSignup: env.openSignup === true,
    });
  });

  api.post("/logout", async (c) => {
    await store.deleteSession(c.get("token"));
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

  /** "Add a household": the caller becomes its first guardian, and it becomes active. */
  api.post("/households", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, HouseholdBody);
    if (b instanceof Response) return b;
    const guardianships = await store.countGuardianships(account.id);
    // On an invite-only server, only people who already run a household may start another.
    if (!env.openSignup && guardianships === 0) {
      return c.json({ error: "only guardians can add a household on this server" }, 403);
    }
    if (guardianships >= MAX_GUARDIANSHIPS_PER_ACCOUNT) {
      return c.json({ error: "that's as many households as one account can run" }, 403);
    }
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
      },
      env.now(),
    );
    await store.setSessionUser(c.get("token"), guardian.id);
    return c.json({ household, user: guardian }, 201);
  });

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
    }
    if (b.name !== undefined) await store.setAccountName(account.id, b.name);
    const updated = (await store.getAccount(account.id)) as Account;
    return c.json(accountView(updated, serverHost(env, c.req.url)));
  });
}

/** Reads the household hint a companion sends with each request. */
export const householdHint = (header: (name: string) => string | undefined) =>
  header(HOUSEHOLD_HEADER) || undefined;
