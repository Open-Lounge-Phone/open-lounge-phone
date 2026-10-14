import { SESSION_IDLE_MS, type SessionVia } from "@openloungephone/core";
import type { Account, Household, User } from "@openloungephone/db";
import { fromBase64Url, Id, toBase64Url } from "@openloungephone/protocol";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { accountView, resolveSession, serverHost } from "./accounts.ts";
import { audit, auditFrom } from "./audit.ts";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, clientIp, guardianOnly, ipBucket, relyingParty, type Vars } from "./httpUtil.ts";
import { deleteAccountEverywhere } from "./leaving.ts";
import { limitsOf } from "./limits.ts";
import { noticeSignIn, sessionOptions } from "./sessions.ts";
import { dropVoicemailBlobs } from "./voicemail.ts";
import { roleOf, workplaceSpace } from "./workplace.ts";

const Name = z.string().trim().min(1).max(24);

const InviteBody = z.union([
  z.object({ name: Name, role: z.enum(["guardian", "contact"]) }),
  z.object({ userId: Id }),
]);
const TokenBody = z.object({ token: z.string().min(1).max(128) });
const RegisterVerifyBody = z.object({
  challengeId: Id,
  name: z.string().trim().min(1).max(40).default("Passkey"),
  // Shapes are validated by SimpleWebAuthn; we only require an object.
  response: z.looseObject({ id: z.string() }),
});
const LoginVerifyBody = z.object({
  challengeId: Id,
  response: z.looseObject({ id: z.string() }),
});

/** Opens a session for `account` (with `user`'s space active, if any), or reuses `existingToken`. */
async function signIn(
  env: ServerEnv,
  c: Context,
  account: Account,
  user: User | undefined,
  how: { via: SessionVia; passkey: boolean },
  existingToken?: string,
) {
  const { store } = env;
  const now = env.now();
  const token =
    existingToken ??
    (await store.createAccountSession(
      account.id,
      user?.id ?? null,
      now,
      sessionOptions(c, how.via, { passkey: how.passkey }),
    ));
  if (existingToken && user) await store.setSessionUser(existingToken, user.id);
  const household = user ? ((await store.getHousehold(user.householdId)) as Household) : null;
  return {
    token,
    user: user ?? null,
    household,
    account: accountView(account, serverHost(env, c.req.url)),
  };
}

/** How many spaces an account is in here (sign-in links work only for people in just one). */
const spacesOf = async (env: ServerEnv, accountId: string) =>
  (await env.store.listMemberships(accountId)).length;

/** Why a sign-in link can't be made or used for someone in other spaces too. */
const elsewhereText = (name: string) =>
  `${name} is in other spaces too, so a sign-in link here can't be used. They can sign in with another passkey or their recovery code`;

/** Routes that work without a session: invite acceptance and passkey sign-in. */
export function publicPeopleRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.get("/invites/:token", async (c) => {
    const invite = await store.peekInvite(c.req.param("token"), env.now());
    if (!invite) return c.json({ error: "this invite link has expired or was already used" }, 404);
    const household = await store.getHousehold(invite.householdId);
    return c.json({
      householdId: invite.householdId,
      householdName: household?.name ?? "",
      name: invite.name,
      role: invite.role,
      existing: invite.userId !== null,
    });
  });

  /**
   * Accepts an invite. Signed in (a bearer token), a new-person invite adds a membership to your
   * existing account and makes that household active; otherwise it creates a new person. A
   * sign-in link always signs in the person it names.
   */
  api.post("/invites/accept", async (c) => {
    const b = await body(c.req.raw, TokenBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const gone = () => c.json({ error: "this invite link has expired or was already used" }, 404);
    const invite = await store.peekInvite(b.token, now);
    if (!invite) return gone();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const session = bearer ? await resolveSession(store, bearer, undefined, now) : undefined;
    // A stale saved session must not turn into a brand-new account (the app signs out and
    // tries again), and a suspension isn't side-stepped by joining as someone new.
    if (session === "unauthorized") return c.json({ error: "unauthorized" }, 401);
    if (session === "suspended") {
      return c.json({ error: "this account is suspended", code: "suspended" }, 403);
    }
    if (typeof session === "object" && session.session.limited) {
      return c.json({ error: "add a passkey first", code: "passkey_required" }, 403);
    }
    if (invite.userId) {
      // A sign-in link: it signs in the person it names, and only someone whose only space
      // this is (it would open their other spaces too).
      const target = await store.getUser(invite.userId);
      if (!target) return gone();
      if ((await spacesOf(env, target.accountId)) > 1) {
        return c.json({ error: elsewhereText(target.name), code: "in_other_spaces" }, 409);
      }
      if ((await store.getAccount(target.accountId))?.suspendedAt != null) {
        return c.json({ error: "this account is suspended", code: "suspended" }, 403);
      }
      const user = await store.acceptInvite(b.token, now);
      const account = user && (await store.getAccount(user.accountId));
      if (!user || !account) return gone();
      await audit(env, { user, account }, "signin_link.use", { userId: user.id, name: user.name });
      await noticeSignIn(env, live, account.id, "signin_link");
      return c.json(await signIn(env, c, account, user, { via: "link", passkey: false }), 201);
    }
    const account = typeof session === "object" ? session.account : undefined;
    if (account && (await store.membership(account.id, invite.householdId))) {
      return c.json(
        {
          error: "you're already in this space",
          code: "already_member",
          householdId: invite.householdId,
        },
        409,
      );
    }
    const user = await store.acceptInvite(b.token, now, account?.id);
    if (!user) return gone();
    const joined = account ?? ((await store.getAccount(user.accountId)) as Account);
    return c.json(
      {
        ...(await signIn(
          env,
          c,
          joined,
          user,
          { via: "invite", passkey: false },
          account ? bearer : undefined,
        )),
        // A brand-new account: the app shows its recovery code next.
        newAccount: !account,
      },
      201,
    );
  });

  api.post("/passkeys/login/options", async (c) => {
    const perMinute = limitsOf(env).signInsPerIpPerMinute;
    const bucket = await ipBucket("signin-ip", clientIp(env, c));
    if (!(await store.connections.hit(bucket, 60_000, perMinute, env.now()))) {
      return c.json({ error: "too many attempts; wait a minute" }, 429);
    }
    const { rpID } = relyingParty(env, c.req.url);
    // No allowCredentials: the browser offers any discoverable passkey for this site.
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    const challengeId = await store.saveChallenge(
      { kind: "login", challenge: options.challenge },
      env.now(),
    );
    return c.json({ challengeId, options });
  });

  api.post("/passkeys/login/verify", async (c) => {
    const b = await body(c.req.raw, LoginVerifyBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const challenge = await store.takeChallenge(b.challengeId, "login", now);
    if (!challenge) return c.json({ error: "sign-in failed; try again" }, 401);
    const passkey = await store.getPasskey(b.response.id);
    if (!passkey) {
      // A passkey left on the device after it was removed here (or its account deleted).
      return c.json(
        {
          error:
            "this passkey isn't linked to an account here any more. Use another passkey or your recovery code",
          code: "unknown_passkey",
        },
        401,
      );
    }
    const { rpID, origin } = relyingParty(env, c.req.url);
    try {
      const result = await verifyAuthenticationResponse({
        // biome-ignore lint/suspicious/noExplicitAny: validated by SimpleWebAuthn
        response: b.response as any,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.id,
          publicKey: fromBase64Url(passkey.publicKey),
          counter: passkey.counter,
          // biome-ignore lint/suspicious/noExplicitAny: stored as strings
          transports: passkey.transports as any,
        },
      });
      if (!result.verified) return c.json({ error: "sign-in failed; try again" }, 401);
      await store.touchPasskey(passkey.id, result.authenticationInfo.newCounter, now);
    } catch (e) {
      env.log("warn", "passkey sign-in rejected", { error: String(e) });
      return c.json({ error: "sign-in failed; try again" }, 401);
    }
    const account = await store.getAccount(passkey.accountId);
    if (!account) return c.json({ error: "sign-in failed; try again" }, 401);
    if (account.suspendedAt !== null) {
      return c.json({ error: "this account is suspended", code: "suspended" }, 403);
    }
    // Someone in no space can still sign in (to start one, take their data, or leave).
    const [user] = (await store.listMemberships(passkey.accountId)).map((m) => m.user);
    return c.json(await signIn(env, c, account, user, { via: "passkey", passkey: true }));
  });
}

/** Routes that need a session: people, invites, and managing your passkeys. */
export function peopleRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.post("/invites", guardianOnly, async (c) => {
    const me = c.get("user");
    const b = await body(c.req.raw, InviteBody);
    if (b instanceof Response) return b;
    const myRole = await roleOf(env, me);
    const workplace = !!(await workplaceSpace(env, me.householdId));
    if ("userId" in b) {
      // A sign-in link for someone already here.
      const existing = await store.getUser(b.userId);
      if (!existing || existing.householdId !== me.householdId) {
        return c.json({ error: "not found" }, 404);
      }
      const theirRole = await roleOf(env, existing);
      if (theirRole === "owner" && existing.id !== me.id) {
        return c.json({ error: `${existing.name} owns this space; only they can do that` }, 403);
      }
      if (workplace && theirRole === "admin" && myRole !== "owner") {
        return c.json({ error: "only the owner makes sign-in links for admins" }, 403);
      }
      if ((await spacesOf(env, existing.accountId)) > 1) {
        return c.json({ error: elsewhereText(existing.name), code: "in_other_spaces" }, 409);
      }
      // A new link replaces their older ones.
      await store.auth.cancelSignInLinks(existing.id);
      const invite = await store.createInvite(
        {
          householdId: me.householdId,
          createdBy: me.id,
          userId: existing.id,
          name: existing.name,
          role: existing.role,
        },
        env.now(),
      );
      await auditFrom(env, c, "signin_link.create", { userId: existing.id, name: existing.name });
      return c.json(invite, 201);
    }
    // Team/org spaces: only the owner makes admins.
    if (b.role === "guardian" && workplace && myRole !== "owner") {
      return c.json({ error: "only the owner invites admins" }, 403);
    }
    const invite = await store.createInvite(
      { householdId: me.householdId, createdBy: me.id, name: b.name, role: b.role },
      env.now(),
    );
    await auditFrom(env, c, "invite.create", { name: b.name, role: b.role });
    return c.json(invite, 201);
  });

  /** Invites and sign-in links of this space that can still be used (never their tokens). */
  api.get("/invites", guardianOnly, async (c) => {
    const me = c.get("user");
    const [invites, users] = await Promise.all([
      store.auth.invites(me.householdId, env.now()),
      store.listUsers(me.householdId),
    ]);
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    return c.json(
      invites.map((i) => ({
        id: i.id,
        kind: i.userId ? "signin" : "invite",
        name: i.name,
        role: i.role,
        ...(i.userId ? { userId: i.userId } : {}),
        createdBy: nameOf.get(i.createdBy) ?? "",
        createdAt: i.createdAt,
        expiresAt: i.expiresAt,
      })),
    );
  });

  /** Cancels an invite or sign-in link: it stops working at once. */
  api.delete("/invites/:id", guardianOnly, async (c) => {
    const me = c.get("user");
    const gone = await store.auth.cancelInvite(me.householdId, c.req.param("id"));
    if (!gone) return c.json({ error: "not found" }, 404);
    await auditFrom(env, c, gone.userId ? "signin_link.cancel" : "invite.cancel", {
      name: gone.name,
      ...(gone.userId ? { userId: gone.userId } : {}),
    });
    return c.body(null, 204);
  });

  api.delete("/users/:id", guardianOnly, async (c) => {
    const me = c.get("user");
    const target = await store.getUser(c.req.param("id"));
    if (!target || target.householdId !== me.householdId)
      return c.json({ error: "not found" }, 404);
    if (target.id === me.id) {
      return c.json({ error: "to leave, use Leave this space on your Account page" }, 400);
    }
    const theirRole = await roleOf(env, target);
    if (theirRole === "owner") {
      return c.json(
        { error: `${target.name} owns this space and can't be removed; they can hand it on` },
        403,
      );
    }
    if ((await workplaceSpace(env, me.householdId)) && theirRole === "admin") {
      // Admins are made and unmade by the owner.
      if ((await roleOf(env, me)) !== "owner") {
        return c.json({ error: "only the owner removes admins" }, 403);
      }
    }
    const account = await store.getAccount(target.accountId);
    const onlySpace = (await spacesOf(env, target.accountId)) === 1;
    await auditFrom(env, c, "member.remove", {
      userId: target.id,
      name: target.name,
      ...(onlySpace ? { accountDeleted: true } : {}),
    });
    if (onlySpace && account) {
      // This was their only space: their account goes with it (connections are told, as when
      // they delete it themselves).
      await deleteAccountEverywhere(env, live, account);
      return c.json({ accountDeleted: true });
    }
    await live.closeApps(me.householdId, target.id, { removed: true });
    await dropVoicemailBlobs(env, { userId: target.id });
    await store.deleteUser(target.id, env.now());
    // A Lounge phone they were using forgets them now.
    for (const d of await store.listDevices(me.householdId)) {
      if (d.kind === "lounge") await live.refreshDevice(me.householdId, d.id);
    }
    return c.json({ accountDeleted: false });
  });

  api.get("/passkeys", async (c) => {
    const passkeys = await store.listPasskeys(c.get("account").id);
    return c.json(
      passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
    );
  });

  /**
   * Removes a passkey. The last one goes only when the account has a recovery code (else the
   * account could be left with no way in). It doesn't sign anyone out; `POST
   * /sessions/sign-out-others` does that.
   */
  api.delete("/passkeys/:id", async (c) => {
    const account = c.get("account");
    const passkeys = await store.listPasskeys(account.id);
    const passkey = passkeys.find((p) => p.id === c.req.param("id"));
    if (!passkey) return c.json({ error: "not found" }, 404);
    if (passkeys.length === 1 && !account.hasRecoveryCode) {
      return c.json(
        {
          error:
            "this is your last passkey. Make a recovery code first, or add another passkey, so you can still get in",
          code: "last_passkey",
        },
        409,
      );
    }
    await store.deletePasskey(passkey.id, account.id);
    return c.json({ remaining: passkeys.length - 1 });
  });

  api.post("/passkeys/register/options", async (c) => {
    const account = c.get("account");
    const { rpID } = relyingParty(env, c.req.url);
    const existing = await store.listPasskeys(account.id);
    const options = await generateRegistrationOptions({
      rpName: "Open Lounge Phone",
      rpID,
      userName: `${account.handle}@${serverHost(env, c.req.url)}`,
      userDisplayName: account.name,
      userID: new TextEncoder().encode(account.id),
      attestationType: "none",
      // biome-ignore lint/suspicious/noExplicitAny: stored as strings
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as any })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await store.saveChallenge(
      { kind: "register", challenge: options.challenge, accountId: account.id },
      env.now(),
    );
    return c.json({ challengeId, options });
  });

  api.post("/passkeys/register/verify", async (c) => {
    const account = c.get("account");
    const b = await body(c.req.raw, RegisterVerifyBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const challenge = await store.takeChallenge(b.challengeId, "register", now);
    if (!challenge || challenge.accountId !== account.id) {
      return c.json({ error: "that took too long; try again" }, 400);
    }
    const { rpID, origin } = relyingParty(env, c.req.url);
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
      // A recovery ends here: its code is used up before the passkey is saved, so of two
      // recoveries with the same code only one gets a passkey.
      if (c.get("session").limited && !(await store.auth.consumeRecoveryCode(account.id))) {
        return c.json(
          { error: "this recovery code was already used; start again with your newest code" },
          409,
        );
      }
      const { credential } = result.registrationInfo;
      await store.addPasskey({
        id: credential.id,
        accountId: account.id,
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ?? [],
        name: b.name,
        createdAt: now,
      });
    } catch (e) {
      env.log("warn", "passkey registration rejected", { error: String(e) });
      return c.json({ error: "could not verify the passkey" }, 400);
    }
    // This session is now backed by a passkey: it slides, and a recovery session is a full one.
    const session = c.get("session");
    if (session.id) await store.auth.sessionGotPasskey(session.id, now + SESSION_IDLE_MS, now);
    return c.body(null, 201);
  });
}
