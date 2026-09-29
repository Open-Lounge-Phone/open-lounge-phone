import { beforeEach, describe, expect, it } from "vitest";
import { fairUseFromVars, HUB_FAIR_USE, hubInfoFromVars } from "./limits.ts";
import { expectStatus, type FakeConn, TestServer } from "./testkit.ts";

const MINUTE = 60_000;

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://hub.test" });
});

/** Two grown-ups in one space, both online. */
async function pair() {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "guardian" },
    0,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  return {
    mom,
    dad,
    momApp: await s.connectApp(mom.token),
    dadApp: await s.connectApp(dadToken),
  };
}

/** Mom calls Dad; they talk for `minutes`; Mom hangs up. */
async function talk(momApp: FakeConn, dadApp: FakeConn, dadId: string, minutes: number) {
  momApp.write({ t: "call.user", userId: dadId });
  const { callId } = await dadApp.next("call.ringing");
  dadApp.write({ t: "call.answer", callId });
  await momApp.nextState("connecting");
  momApp.write({ t: "rtc.sdp", callId, type: "offer", sdp: "v=0" });
  await dadApp.next("rtc.sdp");
  dadApp.write({ t: "rtc.sdp", callId, type: "answer", sdp: "v=0" });
  await momApp.nextState("active");
  s.timers.advance(minutes * MINUTE);
  return callId;
}

describe("fair-use allowance", () => {
  it("applies only where configured: unlimited by default, the hub's defaults with FAIR_USE=hub", () => {
    expect(fairUseFromVars({})).toBeUndefined();
    expect(fairUseFromVars({ OPEN_SIGNUP: "1" })).toBeUndefined();
    expect(fairUseFromVars({ FAIR_USE: "hub" })).toEqual(HUB_FAIR_USE);
    expect(
      fairUseFromVars({
        FAIR_USE: "hub",
        FAIR_USE_CALL_MINUTES: "50",
        FAIR_USE_VOICEMAILS: "unlimited",
      }),
    ).toEqual({ ...HUB_FAIR_USE, callMinutesPerMonth: 50, voicemailsPerMonth: undefined });
    expect(fairUseFromVars({ FAIR_USE_PHONES_PER_SPACE: "2" })).toEqual({ phonesPerSpace: 2 });
    // A server with no allowance meters but never refuses.
    expect(s.env.fairUse).toBeUndefined();
  });

  it("refuses a call at the start once the month's minutes are used; never cuts one off", async () => {
    s.env.fairUse = { callMinutesPerMonth: 5 };
    const { mom, dad, momApp, dadApp } = await pair();
    // A 4-minute call, then one that runs over: it isn't cut off.
    let callId = await talk(momApp, dadApp, dad.id, 4);
    momApp.write({ t: "call.hangup", callId });
    await dadApp.nextState("ended");
    expect((await s.store.usage(mom.account.id, s.timers.now)).callMinutes).toBe(4);
    expect(await s.store.callLog(mom.account.id, `user:${dad.id}`)).toMatchObject([
      { direction: "out", peerLabel: "Dad", answered: true, durationMs: 4 * MINUTE },
    ]);
    expect(await s.store.callLog(dad.accountId, `user:${mom.user.id}`)).toMatchObject([
      { direction: "in", peerLabel: "Mom" },
    ]);
    callId = await talk(momApp, dadApp, dad.id, 10);
    expect(momApp.all("call.state").filter((m) => m.state === "ended")).toHaveLength(1);
    momApp.write({ t: "call.hangup", callId });
    await dadApp.nextState("ended");
    expect((await s.store.usage(mom.account.id, s.timers.now)).callMinutes).toBe(14);
    // Now over: the next call is refused with the reason, before anything rings.
    const rings = dadApp.all("call.ringing").length;
    momApp.write({ t: "call.user", userId: dad.id });
    let refused = await momApp.nextState("ended");
    while (refused.reason !== "denied") refused = await momApp.nextState("ended");
    expect(refused.note).toMatch(/5 call minutes \(fair use\)\. It resets on Apr 1/);
    expect(dadApp.all("call.ringing")).toHaveLength(rings);
    // Dad (another account) still has his minutes.
    const back = await talk(dadApp, momApp, mom.user.id, 1);
    dadApp.write({ t: "call.hangup", callId: back });
    await momApp.nextState("ended");
    const usage = await s.http("/usage", { token: mom.token });
    expect(usage.json).toMatchObject({
      month: "2026-03",
      callMinutes: 14,
      limits: { callMinutesPerMonth: 5 },
      resetsOn: "Apr 1",
    });
  });

  it("resets with the month, and exempt accounts aren't held to it", async () => {
    s.env.fairUse = { callMinutesPerMonth: 1 };
    const { mom, dad, momApp, dadApp } = await pair();
    const callId = await talk(momApp, dadApp, dad.id, 2);
    momApp.write({ t: "call.hangup", callId });
    await dadApp.nextState("ended");
    await momApp.nextState("ended");
    momApp.write({ t: "call.user", userId: dad.id });
    expect((await momApp.nextState("ended")).note).toMatch(/fair use/);
    // An operator exempts the account (e.g. a venue).
    await s.store.setFairUseExempt(mom.account.id, true);
    momApp.write({ t: "call.user", userId: dad.id });
    const ring = await dadApp.next("call.ringing");
    dadApp.write({ t: "call.hangup", callId: ring.callId });
    await momApp.nextState("ended");
    await s.store.setFairUseExempt(mom.account.id, false);
    // The first of next month: a fresh allowance.
    s.timers.now = Date.UTC(2026, 3, 1, 0, 0, 1);
    expect((await s.store.usage(mom.account.id, s.timers.now)).callMinutes).toBe(0);
    momApp.write({ t: "call.user", userId: dad.id });
    expect((await dadApp.next("call.ringing")).from.label).toBe("Mom");
  });

  it("limits voicemails, knocks, phones per space and spaces per account", async () => {
    s.env.fairUse = {
      voicemailsPerMonth: 1,
      knocksPerMonth: 1,
      phonesPerSpace: 1,
      spacesPerAccount: 1,
    };
    const mom = await s.person("mom", "Mom");
    const kid = await s.pairDevice(mom.token, "Kid phone");
    expectStatus(kid, 201);
    const second = await s.pairDevice(mom.token, "Second phone");
    expectStatus(second, 403);
    expect(second.error).toMatch(/1 phones on this server \(fair use\)/);
    const vm = () =>
      s.http(`/devices/${kid.deviceId}/voicemail?durationMs=1000`, {
        token: mom.token,
        raw: new Uint8Array(100),
        type: "audio/webm",
      });
    expectStatus(await vm(), 201);
    const over = await vm();
    expectStatus(over, 429);
    expect(over.json.error).toMatch(/1 voicemails \(fair use\)/);
    expectStatus(
      await s.http("/connections", { token: mom.token, body: { to: "aa@hub.test" } }),
      202,
    );
    const knock = await s.http("/connections", { token: mom.token, body: { to: "bb@hub.test" } });
    expectStatus(knock, 429);
    expect(knock.json.error).toMatch(/knocked 1 times this month/);
    const space = await s.http("/spaces", {
      token: mom.token,
      body: { name: "Studio", type: "team" },
    });
    expectStatus(space, 403);
    expect((await s.store.usage(mom.account.id, s.timers.now)).voicemails).toBe(1);
  });
});

describe("abuse controls", () => {
  it("requires Turnstile on sign-up when configured", async () => {
    s.env.openSignup = true;
    const verified: string[] = [];
    s.env.turnstile = { siteKey: "site-key", secret: "secret" };
    s.env.fetch = async (req) => {
      expect(req.url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      const form = await req.formData();
      verified.push(String(form.get("response")));
      return Response.json({
        success: form.get("response") === "good" && form.get("secret") === "secret",
      });
    };
    expect((await s.http("/setup")).json).toMatchObject({ turnstileSiteKey: "site-key" });
    const opts = (turnstileToken?: string) =>
      s.http("/signup/options", {
        body: {
          handle: "jesse",
          name: "J",
          timeZone: "UTC",
          ...(turnstileToken ? { turnstileToken } : {}),
        },
      });
    expectStatus(await opts(), 403);
    expectStatus(await opts("bad"), 403);
    expectStatus(await opts("good"), 200);
    expect(verified).toEqual(["bad", "good"]);
    // Without keys there's no check at all.
    s.env.turnstile = undefined;
    expect((await s.http("/setup")).json.turnstileSiteKey).toBeUndefined();
    expectStatus(await opts(), 200);
  });

  it("limits sign-ups per IP address and changes per account", async () => {
    s.env.openSignup = true;
    s.env.limits = { signupsPerIpPerHour: 2, writesPerAccountPerMinute: 3 };
    const opts = (ip: string) =>
      s.http("/signup/options", {
        body: { handle: `h${ip.replace(/\D/g, "")}x`, name: "J", timeZone: "UTC" },
        headers: { "cf-connecting-ip": ip },
      });
    expectStatus(await opts("1.1.1.1"), 200);
    expectStatus(await opts("1.1.1.1"), 200);
    expectStatus(await opts("1.1.1.1"), 429);
    expectStatus(await opts("2.2.2.2"), 200);
    s.timers.advance(60 * MINUTE);
    expectStatus(await opts("1.1.1.1"), 200);

    const mom = await s.person("mom");
    const change = () =>
      s.http("/account", { method: "PATCH", token: mom.token, body: { name: "M" } });
    for (let i = 0; i < 3; i++) expectStatus(await change(), 200);
    expectStatus(await change(), 429);
    expectStatus(await s.http("/me", { token: mom.token }), 200); // reads aren't limited
  });

  it("lets operators suspend and exempt accounts and block servers; nobody else", async () => {
    s.env.operators = ["boss"];
    const boss = await s.person("boss");
    const eve = await s.person("eve");
    expect((await s.http("/me", { token: boss.token })).json.operator).toBe(true);
    expect((await s.http("/me", { token: eve.token })).json.operator).toBe(false);
    for (const path of ["/admin/overview", "/admin/accounts?handle=boss"]) {
      expectStatus(await s.http(path, { token: eve.token }), 403);
    }
    expectStatus(
      await s.http(`/admin/accounts/${boss.account.id}/suspend`, {
        token: eve.token,
        body: { suspended: true },
      }),
      403,
    );
    const found = await s.http("/admin/accounts?handle=eve@hub.test", { token: boss.token });
    expect(found.json).toMatchObject({ handle: "eve", suspended: false, exempt: false });
    const eveApp = await s.connectApp(eve.token);
    expectStatus(
      await s.http(`/admin/accounts/${eve.account.id}/suspend`, {
        token: boss.token,
        body: { suspended: true },
      }),
      204,
    );
    // Suspended: no API, no new sockets, and knocks to them go nowhere.
    expect(await s.http("/me", { token: eve.token })).toMatchObject({ status: 403 });
    const again = s.openApp();
    again.write({ t: "app.hello", proto: 1, token: eve.token });
    await expect.poll(() => again.closed?.code).toBe(4401);
    await s.http("/connections", { token: boss.token, body: { to: "eve@hub.test" } });
    expect(await s.store.connections.list(eve.account.id)).toEqual([]);
    void eveApp;
    // Exempt, and block a server.
    expectStatus(
      await s.http(`/admin/accounts/${eve.account.id}/exempt`, {
        token: boss.token,
        body: { exempt: true },
      }),
      204,
    );
    expect((await s.store.getAccount(eve.account.id))?.fairUseExempt).toBe(true);
    expectStatus(
      await s.http("/admin/servers/block", {
        token: boss.token,
        body: { host: "spam.example", reason: "spam" },
      }),
      204,
    );
    const overview = await s.http("/admin/overview", { token: boss.token });
    expect(overview.json.blockedServers).toMatchObject([{ host: "spam.example", reason: "spam" }]);
    expect(overview.json.counts).toMatchObject({ accounts: 2, suspended: 1, exempt: 1 });
    expectStatus(
      await s.http("/admin/servers/spam.example", { method: "DELETE", token: boss.token }),
      204,
    );
    expect(await s.store.connections.serverBlocked("spam.example")).toBe(false);
  });
});

describe("funding transparency", () => {
  it("shows funding and the Sponsor link only when configured, never a placeholder", async () => {
    expect((await s.http("/hub")).json).toEqual({ fairUse: null, funding: null, sponsorUrl: null });
    expect(hubInfoFromVars({})).toBeUndefined();
    expect(hubInfoFromVars({ SPONSOR_URL: "" })).toBeUndefined();
    expect(hubInfoFromVars({ SPONSOR_URL: "TODO" })).toBeUndefined();
    s.env.hub = hubInfoFromVars({ FUNDING_BALANCE_USD: "150" });
    s.env.fairUse = HUB_FAIR_USE;
    const hub = (await s.http("/hub")).json;
    expect(hub.funding.summary).toEqual({
      balanceUsd: 150,
      peoplePerDollarPerMonth: 50,
      peopleForAYear: 375,
      peopleForSixMonths: 1000,
    });
    expect(hub.sponsorUrl).toBeNull();
    s.env.hub = hubInfoFromVars({
      FUNDING_BALANCE_USD: "150",
      SPONSOR_URL: "https://github.com/sponsors/example",
    });
    expect((await s.http("/hub")).json.sponsorUrl).toBe("https://github.com/sponsors/example");
  });
});

describe("leaving", () => {
  it("exports your data, then deletes the account; shared spaces stay, sole ones go", async () => {
    const jesse = await s.person("jesse", "Jesse");
    const bob = await s.person("bob", "Bob");
    const kid = await s.pairDevice(jesse.token, "Kid phone");
    // Jesse is also a co-guardian of Bob's home.
    const co = await s.store.createUser(
      {
        householdId: bob.household.id,
        name: "Jesse",
        role: "guardian",
        accountId: jesse.account.id,
      },
      s.timers.now + 1,
    );
    await s.http("/connections", { token: jesse.token, body: { to: "bob@hub.test" } });
    const [req] = (await s.http("/connections", { token: bob.token })).json.connections;
    await s.http(`/connections/${req.id}/accept`, { method: "POST", token: bob.token });

    const exported = await s.http("/account/export", { token: jesse.token });
    expectStatus(exported, 200);
    expect(exported.headers.get("content-disposition")).toMatch(/jesse@hub\.test\.json/);
    expect(exported.json).toMatchObject({
      format: "openloungephone-export",
      version: 1,
      server: "hub.test",
      account: { handle: "jesse", address: "jesse@hub.test" },
      connections: [{ address: "bob@hub.test", state: "active", peerId: bob.account.id }],
      spaces: [
        { name: "Jesse's home", role: "guardian", phones: [{ name: "Kid phone", kind: "kids" }] },
        { name: "Bob's home", role: "guardian" },
      ],
    });

    expectStatus(
      await s.http("/account", { method: "DELETE", token: jesse.token, body: { confirm: "nope" } }),
      400,
    );
    expectStatus(
      await s.http("/account", {
        method: "DELETE",
        token: jesse.token,
        body: { confirm: "jesse" },
      }),
      204,
    );
    expectStatus(await s.http("/me", { token: jesse.token }), 401);
    expect(await s.store.getHousehold(jesse.household.id)).toBeUndefined();
    expect(await s.store.getDevice(kid.deviceId as string)).toBeUndefined();
    expect(await s.store.getHousehold(bob.household.id)).toBeDefined();
    expect(await s.store.getUser(co.id)).toBeUndefined();
    expect((await s.http("/connections", { token: bob.token })).json.connections).toEqual([]);
    expect(await s.store.handleAvailable("jesse", s.timers.now)).toBe(false);
  });
});
