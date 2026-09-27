import type { Household, Role, Store, User } from "@opentincan/db";
import { fromBase64Url, Id, toBase64Url } from "@opentincan/protocol";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Hono } from "hono";
import { z } from "zod";
import type { ServerEnv } from "./env.ts";
import { body, guardianOnly, type Vars } from "./httpUtil.ts";

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

/** Relying-party identity: PUBLIC_URL when configured (reverse proxies), else the request URL. */
function relyingParty(env: ServerEnv, requestUrl: string): { rpID: string; origin: string } {
  const url = new URL(env.publicUrl ?? requestUrl);
  return { rpID: url.hostname, origin: url.origin };
}

async function signIn(store: Store, user: User, now: number) {
  const token = await store.createSession(user.id, now);
  const household = (await store.getHousehold(user.householdId)) as Household;
  return { token, user, household };
}

/** Routes that work without a session: invite acceptance and passkey sign-in. */
export function publicPeopleRoutes(api: Hono<Vars>, env: ServerEnv): void {
  const { store } = env;

  api.get("/invites/:token", async (c) => {
    const invite = await store.peekInvite(c.req.param("token"), env.now());
    if (!invite) return c.json({ error: "this invite link has expired or was already used" }, 404);
    const household = await store.getHousehold(invite.householdId);
    return c.json({
      householdName: household?.name ?? "",
      name: invite.name,
      role: invite.role,
      existing: invite.userId !== null,
    });
  });

  api.post("/invites/accept", async (c) => {
    const b = await body(c.req.raw, TokenBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const user = await store.acceptInvite(b.token, now);
    if (!user) return c.json({ error: "this invite link has expired or was already used" }, 404);
    return c.json(await signIn(store, user, now), 201);
  });

  api.post("/passkeys/login/options", async (c) => {
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
    const user = await store.getUser(passkey.userId);
    if (!user) return c.json({ error: "sign-in failed; try again" }, 401);
    return c.json(await signIn(store, user, now));
  });
}

/** Routes that need a session: people, invites, and managing your passkeys. */
export function peopleRoutes(api: Hono<Vars>, env: ServerEnv): void {
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
    await store.deleteUser(target.id);
    return c.body(null, 204);
  });

  api.get("/passkeys", async (c) => {
    const passkeys = await store.listPasskeys(c.get("user").id);
    return c.json(
      passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
    );
  });

  api.delete("/passkeys/:id", async (c) => {
    const ok = await store.deletePasskey(c.req.param("id"), c.get("user").id);
    return ok ? c.body(null, 204) : c.json({ error: "not found" }, 404);
  });

  api.post("/passkeys/register/options", async (c) => {
    const user = c.get("user");
    const household = await store.getHousehold(user.householdId);
    const { rpID } = relyingParty(env, c.req.url);
    const existing = await store.listPasskeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: "OpenTinCan",
      rpID,
      userName: `${user.name} (${household?.name ?? "OpenTinCan"})`,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      // biome-ignore lint/suspicious/noExplicitAny: stored as strings
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports as any })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const challengeId = await store.saveChallenge(
      { kind: "register", challenge: options.challenge, userId: user.id },
      env.now(),
    );
    return c.json({ challengeId, options });
  });

  api.post("/passkeys/register/verify", async (c) => {
    const user = c.get("user");
    const b = await body(c.req.raw, RegisterVerifyBody);
    if (b instanceof Response) return b;
    const now = env.now();
    const challenge = await store.takeChallenge(b.challengeId, "register", now);
    if (!challenge || challenge.userId !== user.id) {
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
        userId: user.id,
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
