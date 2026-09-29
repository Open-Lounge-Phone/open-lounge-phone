import type { Weekday } from "@openloungephone/core";
import { HANDLE_CHANGE_INTERVAL_MS, HANDLE_RESERVE_MS } from "@openloungephone/db";
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer();
});

describe("handle reservation", () => {
  it("keeps a released handle for its last owner for 90 days", async () => {
    const jesse = await s.person("jesse");
    const change = (token: string, handle: string) =>
      s.http("/account", { method: "PATCH", token, body: { handle } });
    expectStatus(await change(jesse.token, "jesse.g"), 200);
    // Nobody else can take "jesse" now, by sign-up or rename.
    expect(await s.store.handleAvailable("jesse", s.timers.now)).toBe(false);
    expect(await s.store.createAccount({ name: "J", handle: "jesse" }, s.timers.now)).toBe(
      undefined,
    );
    const other = await s.person("other");
    expectStatus(await change(other.token, "jesse"), 409);
    s.env.openSignup = true;
    const signup = await s.http("/signup/options", {
      body: { handle: "jesse", name: "J", timeZone: "UTC" },
    });
    expectStatus(signup, 409);
    // Derived handles skip it too.
    const derived = await s.store.createAccount({ name: "Jesse" }, s.timers.now);
    expect(derived?.handle).toBe("jesse-2");
    // Its owner may take it back.
    s.timers.advance(HANDLE_CHANGE_INTERVAL_MS);
    expectStatus(await change(jesse.token, "jesse"), 200);
    // ...and then "jesse.g" is the reserved one; after 90 days it's free for anyone.
    expectStatus(await change(other.token, "jesse.g"), 409);
    s.timers.advance(HANDLE_RESERVE_MS);
    const fresh = await s.store.createSession(other.user.id, s.timers.now);
    expectStatus(await change(fresh, "jesse.g"), 200);
  });

  it("reserves the handle of an account that left its last household", async () => {
    const mom = await s.person("mom");
    const kid = await s.store.createUser(
      { householdId: mom.household.id, name: "Gran", role: "contact" },
      0,
    );
    const gran = await s.store.getAccount(kid.accountId);
    expectStatus(await s.http(`/users/${kid.id}`, { method: "DELETE", token: mom.token }), 204);
    expect(await s.store.getAccount(kid.accountId)).toBeUndefined();
    expect(await s.store.handleAvailable(gran?.handle as string, s.timers.now)).toBe(false);
    s.timers.advance(HANDLE_RESERVE_MS + 1);
    expect(await s.store.handleAvailable(gran?.handle as string, s.timers.now)).toBe(true);
  });
});

describe("spaces", () => {
  it("creates home, team and org spaces; /me reports the type", async () => {
    const jesse = await s.person("jesse");
    const team = await s.http("/spaces", {
      token: jesse.token,
      body: { name: "Studio", type: "team" },
    });
    expectStatus(team, 201);
    expect(team.json.household.type).toBe("team");
    const home = await s.http("/households", { token: jesse.token, body: { name: "Gran's" } });
    expect(home.json.household.type).toBe("home");
    const bad = await s.http("/spaces", { token: jesse.token, body: { name: "X", type: "club" } });
    expectStatus(bad, 400);
    const me = await s.http("/me", { token: jesse.token });
    expect(me.json.memberships.map((m: { spaceType: string }) => m.spaceType)).toEqual([
      "home",
      "team",
      "home",
    ]);
  });

  it("applies kid-safety rules only in home spaces", async () => {
    const boss = await s.person("boss", "Boss", "team");
    // No kids' phones in a team: a household phone needs a home.
    const kids = await s.pairDevice(boss.token, "Desk");
    expectStatus(kids, 400);
    expect(kids.error).toMatch(/home space/);
    // Your own phone and Lounge phones are fine.
    expectStatus(await s.pairDevice(boss.token, "Mine", { forMe: true }), 201);
    const lounge = await s.pairDevice(boss.token, "Lobby", { kind: "lounge" });
    expectStatus(lounge, 201);
    const mine = (await s.store.listDevices(boss.household.id)).find((d) => d.name === "Mine");
    // Turning your own phone into a household (kid's) phone in place is refused too.
    const release = await s.http(`/devices/${mine?.id}`, {
      method: "PATCH",
      token: boss.token,
      body: { owner: "household" },
    });
    expectStatus(release, 409);
    // No quiet hours in a team, and rules that exist anyway are ignored.
    const rules = [{ days: [0, 1, 2, 3, 4, 5, 6] as Weekday[], start: "00:00", end: "23:59" }];
    expectStatus(
      await s.http("/quiet-hours", { method: "PUT", token: boss.token, body: { rules } }),
      400,
    );
    await s.store.setQuietRules(boss.household.id, rules);
    expect((await s.store.getSchedule(boss.household.id)).rules).toEqual([]);

    // A home still has both.
    const mom = await s.person("mom");
    expectStatus(await s.pairDevice(mom.token, "Kid phone"), 201);
    expectStatus(
      await s.http("/quiet-hours", { method: "PUT", token: mom.token, body: { rules } }),
      204,
    );
    expect((await s.store.getSchedule(mom.household.id)).rules).toHaveLength(1);
  });
});
