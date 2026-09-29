import type { Account, Household, Role, User } from "@openloungephone/db";
import { fromBase64Url, Id, toBase64Url } from "@openloungephone/protocol";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Hono } from "hono";
import { z } from "zod";
import { accountView, resolveSession, serverHost } from "./accounts.ts";
import type { ServerEnv } from "./env.ts";
import type { Coordinator } from "./gateway.ts";
import { body, clientIp, guardianOnly, ipBucket, relyingParty, type Vars } from "./httpUtil.ts";
import { limitsOf } from "./limits.ts";

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

async function signIn(
  env: ServerEnv,
  requestUrl: string,
  user: User,
  now: number,
  existingToken?: string,
) {
  const { store } = env;
  const token = existingToken ?? (await store.createSession(user.id, now));
  if (existingToken) await store.setSessionUser(existingToken, user.id);
  const household = (await store.getHousehold(user.householdId)) as Household;
  const account = (await store.getAccount(user.accountId)) as Account;
  return { token, user, household, account: accountView(account, serverHost(env, requestUrl)) };
}

/** Routes that work without a session: invite acceptance and passkey sign-in. */
export function publicPeopleRoutes(api: Hono<Vars>, env: ServerEnv): void {
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
    const account = typeof session === "object" && !invite.userId ? session.account : undefined;
    if (account && (await store.membership(account.id, invite.householdId))) {
      return c.json({ error: "you're already in this household" }, 409);
    }
    const user = await store.acceptInvite(b.token, now, account?.id);
    if (!user) return gone();
    return c.json(await signIn(env, c.req.url, user, now, account ? bearer : undefined), 201);
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
    const passkey = await store.getPasskey(b.response.id);
    if (!challenge || !passkey) return c.json({ error: "sign-in failed; try again" }, 401);
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
    if (account?.suspendedAt != null) return c.json({ error: "this account is suspended" }, 403);
    const [user] = (await store.listMemberships(passkey.accountId)).map((m) => m.user);
    if (!user) return c.json({ error: "sign-in failed; try again" }, 401);
    return c.json(await signIn(env, c.req.url, user, now));
  });
}

/** Routes that need a session: people, invites, and managing your passkeys. */
export function peopleRoutes(api: Hono<Vars>, env: ServerEnv, live: Coordinator): void {
  const { store } = env;

  api.post("/invites", guardianOnly, async (c) => {
    const me = c.get("user");
    const b = await body(c.req.raw, InviteBody);
    if (b instanceof Response) return b;
    let target: { userId?: string; name: string; role: Role };
    if ("userId" in b) {
      const existing = await store.getUser(b.userId);
      if (!existing || existing.householdId !== me.householdId) {
        return c.json({ error: "not found" }, 404);
      }
      target = { userId: existing.id, name: existing.name, role: existing.role };
    } else {
      target = b;
    }
    const invite = await store.createInvite(
      { householdId: me.householdId, createdBy: me.id, ...target },
      env.now(),
    );
    return c.json(invite, 201);
  });

  api.delete("/users/:id", guardianOnly, async (c) => {
    const me = c.get("user");
    const target = await store.getUser(c.req.param("id"));
    if (!target || target.householdId !== me.householdId)
      return c.json({ error: "not found" }, 404);
    if (target.id === me.id) return c.json({ error: "you can't remove yourself" }, 400);
    await store.deleteUser(target.id, env.now());
    // A Lounge phone they were using forgets them now.
    for (const d of await store.listDevices(me.householdId)) {
      if (d.kind === "lounge") await live.refreshDevice(me.householdId, d.id);
    }
    return c.body(null, 204);
  });

  api.get("/passkeys", async (c) => {
    const passkeys = await store.listPasskeys(c.get("account").id);
    return c.json(
      passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
    );
  });

  api.delete("/passkeys/:id", async (c) => {
    const ok = await store.deletePasskey(c.req.param("id"), c.get("account").id);
    return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
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
    return c.body(null, 201);
  });
}
