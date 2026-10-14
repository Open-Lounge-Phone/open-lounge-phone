// Accounts, sign-in and recovery: recovery codes, sessions, sign-in links, owners and leaving.
import { normalizeRecoveryCode } from "@openloungephone/core";
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, fakeRegistration, TestServer } from "./testkit.ts";

let s: TestServer;
const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  s = new TestServer({
    env: {
      openSignup: true,
      log: (_level, msg, detail) => void logs.push(`${msg} ${JSON.stringify(detail ?? {})}`),
    },
  });
});

const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** Open sign-up with a software passkey; returns the session and the account. */
async function signUp(handle: string, name = handle) {
  const opts = await s.http("/signup/options", { body: { handle, name, timeZone: "UTC" } });
  expectStatus(opts, 200);
  const res = await s.http("/signup", {
    body: {
      challengeId: opts.json.challengeId,
      response: await fakeRegistration(opts.json.options),
    },
    headers: { "user-agent": UA_MAC },
  });
  expectStatus(res, 201);
  return {
    token: res.json.token as string,
    accountId: res.json.account.id as string,
    userId: res.json.user.id as string,
    householdId: res.json.household.id as string,
  };
}

/** Adds a passkey with the session `token` (any session that may). */
async function addPasskey(token: string) {
  const opts = await s.http("/passkeys/register/options", { method: "POST", token });
  if (opts.status !== 200) return opts;
  return s.http("/passkeys/register/verify", {
    token,
    body: {
      challengeId: opts.json.challengeId,
      response: await fakeRegistration(opts.json.options),
    },
  });
}

const recover = (handle: string, code: string, ip = "1.2.3.4") =>
  s.http("/recover", { body: { handle, code }, headers: { "cf-connecting-ip": ip } });

const newCode = async (token: string) => {
  const res = await s.http("/account/recovery-code", { method: "POST", token });
  expectStatus(res, 201);
  return res.json.code as string;
};

describe("recovery codes", () => {
  it("one code, made on request: a passkey-only session, then a new passkey (which uses it up) and code", async () => {
    const jo = await signUp("jo", "Jo");
    expect((await s.http("/me", { token: jo.token })).json.recoveryCode).toBe(false);
    const code = await newCode(jo.token);
    expect(code).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{4}$/);
    expect((await s.http("/me", { token: jo.token })).json.recoveryCode).toBe(true);
    const otherApp = await s.connectApp(jo.token);

    // Wrong handle and wrong code answer exactly alike.
    const wrongCode = await recover("jo", "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA");
    const wrongHandle = await recover("nobody", code);
    expect(wrongCode.status).toBe(401);
    expect(wrongHandle).toEqual(wrongCode);

    // The right one (typed loosely) gives a session that may only add a passkey.
    const res = await recover("Jo@localhost", code.toLowerCase().replace(/-/g, " "));
    expectStatus(res, 200);
    const limited = res.json.token as string;
    expect((await s.http("/me", { token: limited })).json.session).toMatchObject({
      limited: true,
      passkey: false,
      via: "recovery",
    });
    for (const path of ["/devices", "/sessions", "/connections"]) {
      expect((await s.http(path, { token: limited })).json.code).toBe("passkey_required");
    }
    expect(
      (await s.http("/account/recovery-code", { method: "POST", token: limited })).json.code,
    ).toBe("passkey_required");
    const app = s.openApp();
    app.write({ t: "app.hello", proto: 1, token: limited });
    await expect.poll(() => app.closed?.code).toBe(4401);
    // Not used up yet: a cancelled or failed passkey prompt can start again with it.
    expect((await s.store.getAccount(jo.accountId))?.hasRecoveryCode).toBe(true);
    const again = await recover("jo", code);
    expectStatus(again, 200);

    // Their other app hears about it; every space they're in has it in the audit trail.
    expect((await otherApp.next("account.notice")).kind).toBe("recovered");
    const trail = (await s.http("/space/audit", { token: jo.token })).json;
    expect(trail.map((e: { action: string }) => e.action)).toContain("account.recovered");

    // A new passkey makes it a full session and uses the code up; then a new code.
    expectStatus(await addPasskey(limited), 201);
    expect((await s.store.getAccount(jo.accountId))?.hasRecoveryCode).toBe(false);
    expectStatus(await recover("jo", code), 401);
    // The other recovery with the same code can't add a passkey any more.
    expectStatus(await addPasskey(again.json.token), 409);
    expect((await s.http("/me", { token: limited })).json.session).toMatchObject({
      limited: false,
      passkey: true,
    });
    expectStatus(await s.http("/devices", { token: limited }), 200);
    const second = await newCode(limited);
    expect(second).not.toBe(code);

    // The code is never in the audit trail, the logs or an export.
    const plain = (c: string) => normalizeRecoveryCode(c) as string;
    const rows = JSON.stringify(s.sql ? await s.sql.all("SELECT * FROM audit_log") : []);
    const exported = JSON.stringify((await s.http("/account/export", { token: limited })).json);
    for (const c of [code, second]) {
      for (const text of [rows, exported, logs.join("\n")]) {
        expect(text).not.toContain(c);
        expect(text).not.toContain(plain(c));
      }
    }
  });

  it("a new code replaces the old one", async () => {
    const jo = await signUp("jo");
    const first = await newCode(jo.token);
    const second = await newCode(jo.token);
    expectStatus(await recover("jo", first), 401);
    expectStatus(await recover("jo", second), 200);
  });

  it("limits tries per handle and network, per network and per handle a day, the same for handles that don't exist", async () => {
    const jo = await signUp("jo");
    const code = await newCode(jo.token);
    s.env.limits = {
      recoveryAttemptsPerHandlePerHour: 3,
      recoveryAttemptsPerIpPerHour: 5,
      recoveryAttemptsPerHandlePerDay: 6,
    };
    const wrong = "BBBB-BBBB-BBBB-BBBB-BBBB-BBBB-BBBB";
    // A stranger guessing at jo from one network is stopped there...
    for (let i = 0; i < 3; i++) expectStatus(await recover("jo", wrong, "10.0.0.1"), 401);
    expectStatus(await recover("jo", wrong, "10.0.0.1"), 429);
    // ...and doesn't lock jo out from jo's own network.
    expectStatus(await recover("jo", code, "10.0.0.9"), 200);
    // A handle (real or not) has a daily cap from anywhere.
    for (let i = 0; i < 6; i++) expectStatus(await recover("ghost", wrong, `10.0.1.${i}`), 401);
    expectStatus(await recover("ghost", wrong, "10.0.1.9"), 429);
    // Per address, across handles.
    for (let i = 0; i < 5; i++) expectStatus(await recover(`h${i}x`, wrong, "10.9.9.9"), 401);
    expectStatus(await recover("h9x", wrong, "10.9.9.9"), 429);
    s.timers.advance(24 * 60 * 60 * 1000);
    expectStatus(await recover("ghost", wrong, "10.0.1.9"), 401);
  });

  it("a suspended account can't recover", async () => {
    const jo = await signUp("jo");
    const code = await newCode(jo.token);
    await s.store.setSuspended(jo.accountId, s.timers.now);
    expectStatus(await recover("jo", code), 401);
  });
});

describe("sessions", () => {
  it("lists where you're signed in; signs one out, or every other one, closing their apps", async () => {
    const jo = await signUp("jo");
    const phone = await s.store.createAccountSession(jo.accountId, jo.userId, s.timers.now, {
      via: "passkey",
      label: "Safari on iPhone",
      passkey: true,
    });
    const tablet = await s.store.createAccountSession(jo.accountId, jo.userId, s.timers.now, {
      via: "link",
      label: "Chrome on Android",
    });
    const list = (await s.http("/sessions", { token: jo.token })).json;
    expect(list).toHaveLength(3);
    const mine = list.find((x: { current: boolean }) => x.current);
    expect(mine).toMatchObject({ label: "Chrome on Mac", via: "signup", passkey: true });
    const phoneApp = await s.connectApp(phone);
    const tabletApp = await s.connectApp(tablet);
    const myApp = await s.connectApp(jo.token);
    const phoneId = list.find((x: { label: string }) => x.label === "Safari on iPhone").id;

    expectStatus(await s.http(`/sessions/${phoneId}`, { method: "DELETE", token: jo.token }), 204);
    expect(phoneApp.closed?.code).toBe(4401);
    expect(tabletApp.closed).toBeUndefined();
    expectStatus(await s.http("/me", { token: phone }), 401);

    const out = await s.http("/sessions/sign-out-others", { method: "POST", token: jo.token });
    expect(out.json).toEqual({ signedOut: 1 });
    expect(tabletApp.closed?.code).toBe(4401);
    expect(myApp.closed).toBeUndefined();
    expectStatus(await s.http("/me", { token: tablet }), 401);
    // Only your own sessions.
    const bo = await signUp("bo");
    const boId = (await s.http("/sessions", { token: bo.token })).json[0].id;
    expectStatus(await s.http(`/sessions/${boId}`, { method: "DELETE", token: jo.token }), 404);

    // Signing out closes this session's apps too.
    expectStatus(await s.http("/logout", { method: "POST", token: jo.token }), 204);
    expect(myApp.closed?.code).toBe(4401);
  });

  it("a session from a link, with no passkey, says when it ends; making a passkey keeps it going", async () => {
    const mom = await s.person("mom");
    const gran = await s.store.createUser(
      { householdId: mom.household.id, name: "Gran", role: "contact" },
      s.timers.now,
    );
    const link = await s.http("/invites", { token: mom.token, body: { userId: gran.id } });
    const signedIn = await s.http("/invites/accept", { body: { token: link.json.token } });
    expectStatus(signedIn, 201);
    const me = (await s.http("/me", { token: signedIn.json.token })).json;
    expect(me.session).toMatchObject({ passkey: false, via: "link" });
    const ends = me.session.expiresAt;
    s.timers.advance(3 * 24 * 60 * 60 * 1000);
    // Used, but not backed by a passkey: still ends on the same day.
    expect((await s.http("/me", { token: signedIn.json.token })).json.session.expiresAt).toBe(ends);
    expectStatus(await addPasskey(signedIn.json.token), 201);
    expect(
      (await s.http("/me", { token: signedIn.json.token })).json.session.expiresAt,
    ).toBeGreaterThan(ends);
  });
});

describe("passkeys", () => {
  it("the last one goes only when there's a recovery code", async () => {
    const jo = await signUp("jo");
    const [only] = (await s.http("/passkeys", { token: jo.token })).json;
    const remove = () =>
      s.http(`/passkeys/${encodeURIComponent(only.id)}`, { method: "DELETE", token: jo.token });
    expect((await remove()).json.code).toBe("last_passkey");
    await newCode(jo.token);
    expect((await remove()).json).toEqual({ remaining: 0 });
    // Removing it signs nobody out by itself.
    expectStatus(await s.http("/me", { token: jo.token }), 200);
  });

  it("a passkey this server doesn't know gets its own answer", async () => {
    const opts = await s.http("/passkeys/login/options", { method: "POST" });
    const res = await s.http("/passkeys/login/verify", {
      body: { challengeId: opts.json.challengeId, response: { id: "gone-passkey" } },
    });
    expect(res.status).toBe(401);
    expect(res.json.code).toBe("unknown_passkey");
  });
});

describe("invites and sign-in links", () => {
  it("a stale saved session never becomes a new account; a suspended one is refused", async () => {
    const mom = await s.person("mom");
    const invite = await s.http("/invites", {
      token: mom.token,
      body: { name: "Gran", role: "contact" },
    });
    const accounts = async () => (await s.sql.all("SELECT id FROM accounts")).length;
    const eve = await s.person("eve");
    await s.store.setSuspended(eve.account.id, s.timers.now);
    const before = await accounts();
    const stale = await s.http("/invites/accept", {
      token: "x".repeat(43),
      body: { token: invite.json.token },
    });
    expectStatus(stale, 401);
    const suspended = await s.http("/invites/accept", {
      token: eve.token,
      body: { token: invite.json.token },
    });
    expectStatus(suspended, 403);
    expect(suspended.json.code).toBe("suspended");
    expect(await accounts()).toBe(before);
    // Signed out, it still works (once) and says the account is new.
    const fresh = await s.http("/invites/accept", { body: { token: invite.json.token } });
    expectStatus(fresh, 201);
    expect(fresh.json.newAccount).toBe(true);
    expect(fresh.json.token).toBeTruthy();
  });

  it("an invite for someone already here says so", async () => {
    const mom = await s.person("mom");
    const invite = await s.http("/invites", {
      token: mom.token,
      body: { name: "Mom again", role: "contact" },
    });
    const res = await s.http("/invites/accept", {
      token: mom.token,
      body: { token: invite.json.token },
    });
    expectStatus(res, 409);
    expect(res.json).toMatchObject({ code: "already_member", householdId: mom.household.id });
  });

  it("sign-in links: only for someone whose only space this is, never for the owner by others", async () => {
    const mom = await s.person("mom", "Mom");
    const dad = await s.store.createUser(
      { householdId: mom.household.id, name: "Dad", role: "guardian" },
      s.timers.now,
    );
    const dadToken = await s.store.createSession(dad.id, s.timers.now);
    const ana = await s.person("ana", "Ana");
    const anaHere = await s.store.createUser(
      { householdId: mom.household.id, name: "Ana", role: "contact", accountId: ana.account.id },
      s.timers.now,
    );
    const link = (token: string, userId: string) => s.http("/invites", { token, body: { userId } });
    const elsewhere = await link(mom.token, anaHere.id);
    expectStatus(elsewhere, 409);
    expect(elsewhere.json.error).toMatch(/Ana is in other spaces too/);
    // Dad (a guardian) can't make one for Mom (the owner).
    expectStatus(await link(dadToken, mom.user.id), 403);
    // Mom can, for Dad; a new one cancels the old one.
    const first = await link(mom.token, dad.id);
    const second = await link(mom.token, dad.id);
    expectStatus(second, 201);
    expectStatus(await s.http(`/invites/${first.json.token}`), 404);
    const dadApp = await s.connectApp(dadToken);
    expectStatus(await s.http("/invites/accept", { body: { token: second.json.token } }), 201);
    expect((await dadApp.next("account.notice")).kind).toBe("signin_link");
    const actions = (await s.http("/space/audit", { token: mom.token })).json.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["signin_link.create", "signin_link.use"]));
    // A link made while Ana was here only can't be used once she's in another space.
    const gran = await s.store.createUser(
      { householdId: mom.household.id, name: "Gran", role: "contact" },
      s.timers.now,
    );
    const granLink = await link(mom.token, gran.id);
    await s.store.createHousehold(
      { name: "Gran's", timeZone: "UTC", guardianName: "Gran", accountId: gran.accountId },
      s.timers.now,
    );
    const late = await s.http("/invites/accept", { body: { token: granLink.json.token } });
    expectStatus(late, 409);
  });

  it("guardians see and cancel outstanding links", async () => {
    const mom = await s.person("mom", "Mom");
    const invite = await s.http("/invites", {
      token: mom.token,
      body: { name: "Gran", role: "contact" },
    });
    const list = (await s.http("/invites", { token: mom.token })).json;
    expect(list).toEqual([
      expect.objectContaining({ kind: "invite", name: "Gran", createdBy: "Mom" }),
    ]);
    expect(JSON.stringify(list)).not.toContain(invite.json.token);
    const kid = await s.store.createUser(
      { householdId: mom.household.id, name: "Kid", role: "contact" },
      s.timers.now,
    );
    const kidToken = await s.store.createSession(kid.id, s.timers.now);
    expectStatus(await s.http("/invites", { token: kidToken }), 403);
    expectStatus(
      await s.http(`/invites/${list[0].id}`, { method: "DELETE", token: kidToken }),
      403,
    );
    expectStatus(
      await s.http(`/invites/${list[0].id}`, { method: "DELETE", token: mom.token }),
      204,
    );
    expectStatus(await s.http("/invites/accept", { body: { token: invite.json.token } }), 404);
  });
});

describe("owners", () => {
  async function home() {
    const mom = await s.person("mom", "Mom");
    const dadAccount = await s.person("dad", "Dad");
    const dad = await s.store.createUser(
      {
        householdId: mom.household.id,
        name: "Dad",
        role: "contact",
        accountId: dadAccount.account.id,
      },
      s.timers.now,
    );
    const dadToken = await s.store.createAccountSession(dad.accountId, dad.id, s.timers.now);
    return { mom, dad, dadToken };
  }

  it("a home's founder owns it; only they hand it on, to a guardian, and can't be removed", async () => {
    const { mom, dad, dadToken } = await home();
    const users = (await s.http("/users", { token: mom.token })).json;
    expect(users.find((u: { id: string }) => u.id === mom.user.id).owner).toBe(true);
    const transfer = (token: string, userId: string) =>
      s.http("/space/owner", { token, body: { userId } });
    // Dad is a contact: make him a guardian first (only the owner can).
    expectStatus(await transfer(mom.token, dad.id), 403);
    const role = (token: string, id: string, r: string) =>
      s.http(`/users/${id}/role`, { method: "PATCH", token, body: { role: r } });
    expectStatus(await role(dadToken, dad.id, "guardian"), 403);
    expectStatus(await role(mom.token, dad.id, "guardian"), 204);
    // Dad, now a guardian, still can't remove Mom or hand her home on.
    expectStatus(await s.http(`/users/${mom.user.id}`, { method: "DELETE", token: dadToken }), 403);
    expectStatus(await transfer(dadToken, dad.id), 403);
    expectStatus(await role(mom.token, mom.user.id, "contact"), 403);
    expectStatus(await transfer(mom.token, dad.id), 204);
    expect(await s.store.spaceOwnerUser(mom.household.id)).toBe(dad.id);
    // Now Dad owns it; Mom is a guardian he could remove.
    expectStatus(await transfer(mom.token, mom.user.id), 403);
    const trail = (await s.http("/space/audit", { token: dadToken })).json;
    expect(trail.map((e: { action: string }) => e.action)).toContain("owner.transfer");
  });

  it("an owner with others in their space hands it on before deleting their account", async () => {
    const { mom, dad } = await home();
    const del = () =>
      s.http("/account", { method: "DELETE", token: mom.token, body: { confirm: "mom" } });
    const refused = await del();
    expectStatus(refused, 409);
    expect(refused.json).toMatchObject({
      code: "owner_must_transfer",
      spaces: [{ id: mom.household.id, name: "Mom's home" }],
    });
    await s.http(`/users/${dad.id}/role`, {
      method: "PATCH",
      token: mom.token,
      body: { role: "guardian" },
    });
    await s.http("/space/owner", { token: mom.token, body: { userId: dad.id } });
    expectStatus(await del(), 204);
    // The home stays, with Dad as its owner.
    expect(await s.store.getHousehold(mom.household.id)).toBeDefined();
    expect(await s.store.spaceOwnerUser(mom.household.id)).toBe(dad.id);
  });

  it("leaving: the owner hands on first; an only space goes with the account", async () => {
    const { mom, dad, dadToken } = await home();
    // Dad's only space would be this one... he has his own home too (from person()).
    const dadApp = await s.connectApp(dadToken, mom.household.id);
    const leave = (token: string, household?: string) =>
      s.http("/space/leave", { token, body: {}, ...(household ? { household } : {}) });
    expect((await leave(mom.token, mom.household.id)).json.code).toBe("owner");
    const left = await leave(dadToken, mom.household.id);
    expect(left.json).toEqual({ deletedSpace: false });
    expect(dadApp.closed?.code).toBe(4403);
    expect(await s.store.membership(dad.accountId, mom.household.id)).toBeUndefined();
    // Dad still has his own home; it's his only space now.
    expect((await leave(dadToken)).json.code).toBe("only_space");
    // Mom, alone in her home and with another space, deletes it by leaving.
    await s.http("/households", { token: mom.token, body: { name: "Cabin" } });
    const gone = await leave(mom.token, mom.household.id);
    expect(gone.json).toEqual({ deletedSpace: true });
    expect(await s.store.getHousehold(mom.household.id)).toBeUndefined();
  });

  it("removing someone from their only space deletes their account and tells their connections", async () => {
    const mom = await s.person("mom", "Mom");
    const gran = await s.http("/invites", {
      token: mom.token,
      body: { name: "Gran", role: "contact" },
    });
    const joined = await s.http("/invites/accept", { body: { token: gran.json.token } });
    const granUser = joined.json.user;
    const users = (await s.http("/users", { token: mom.token })).json;
    expect(users.find((u: { id: string }) => u.id === granUser.id).onlyHere).toBe(true);
    // Gran is connected with someone; they're told she left.
    const bob = await s.person("bob");
    await s.http("/connections", { token: joined.json.token, body: { to: `bob@${s.host}` } });
    const knock = (await s.store.connections.list(bob.account.id))[0];
    if (knock)
      await s.http(`/connections/${knock.id}/accept`, { method: "POST", token: bob.token });
    const granApp = await s.connectApp(joined.json.token);
    const res = await s.http(`/users/${granUser.id}`, { method: "DELETE", token: mom.token });
    expect(res.json).toEqual({ accountDeleted: true });
    expect(granApp.closed?.code).toBe(4401);
    expect(await s.store.getAccount(granUser.accountId)).toBeUndefined();
    expect(
      (await s.store.connections.list(bob.account.id)).filter((c) => c.state === "active"),
    ).toEqual([]);
  });

  it("someone removed from one of their spaces keeps the rest; their app there closes", async () => {
    const { mom, dad, dadToken } = await home();
    const dadApp = await s.connectApp(dadToken, mom.household.id);
    const res = await s.http(`/users/${dad.id}`, { method: "DELETE", token: mom.token });
    expect(res.json).toEqual({ accountDeleted: false });
    expect(dadApp.closed?.code).toBe(4403);
    expectStatus(await s.http("/me", { token: dadToken }), 200);
  });
});

describe("names", () => {
  it("guardians rename people here (phones' keys follow); everyone renames themselves", async () => {
    const mom = await s.person("mom", "Mom");
    const gran = await s.store.createUser(
      { householdId: mom.household.id, name: "Gran", role: "contact" },
      s.timers.now,
    );
    const granToken = await s.store.createSession(gran.id, s.timers.now);
    const phone = await s.pairDevice(mom.token, "Kid phone");
    await s.store.upsertContact(phone.deviceId as string, {
      id: gran.id,
      label: "Gran",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    const rename = (token: string, id: string, name: string) =>
      s.http(`/users/${id}`, { method: "PATCH", token, body: { name } });
    expectStatus(await rename(granToken, mom.user.id, "Mum"), 403);
    expectStatus(await rename(mom.token, gran.id, "Granny"), 204);
    expect((await s.store.getUser(gran.id))?.name).toBe("Granny");
    expect((await s.store.getContact(phone.deviceId as string, gran.id))?.label).toBe("Granny");
    expectStatus(await rename(granToken, gran.id, "Nana"), 204);
    const trail = (await s.http("/space/audit", { token: mom.token })).json;
    expect(trail.filter((e: { action: string }) => e.action === "member.rename")).toHaveLength(2);
  });
});

describe("no space", () => {
  it("an account in no space still signs in and sees what it can do", async () => {
    const lone = await s.store.createAccount({ name: "Lone", handle: "lone" }, s.timers.now);
    if (!lone) throw new Error("no account");
    const token = await s.store.createAccountSession(lone.id, null, s.timers.now);
    const me = (await s.http("/me", { token })).json;
    expect(me).toMatchObject({ user: null, household: null, canAddSpace: true });
    s.env.openSignup = false;
    expect((await s.http("/me", { token })).json.canAddSpace).toBe(false);
  });
});
