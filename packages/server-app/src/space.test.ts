// A space's Settings: its name and time zone (`PATCH /api/space`). Guardians of a home, the owner
// and admins of a team or org; phones and the hub's alarm follow a new time zone at once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectStatus, NOON_MONDAY, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

/** Waits until `check` holds (phones hear about changes through the hub's queue). */
const until = (check: () => boolean) =>
  vi.waitFor(() => {
    if (!check()) throw new Error("not yet");
  });

const patch = (token: string, body: unknown) => s.http("/space", { method: "PATCH", token, body });

async function member(householdId: string, name: string, role: "guardian" | "contact") {
  const user = await s.store.createUser({ householdId, name, role }, s.timers.now);
  return s.store.createSession(user.id, s.timers.now);
}

describe("space settings: name and time zone", () => {
  it("a home's guardian changes both; it's audited with the old and new values", async () => {
    const mom = await s.person("mom", "Mom");
    const r = await patch(mom.token, { name: "  The Smiths ", timeZone: "Europe/Lisbon" });
    expectStatus(r, 200);
    expect(r.json).toMatchObject({ name: "The Smiths", timeZone: "Europe/Lisbon" });
    const me = await s.http("/me", { token: mom.token });
    expect(me.json.household).toMatchObject({ name: "The Smiths", timeZone: "Europe/Lisbon" });
    const audit = (await s.http("/space/audit", { token: mom.token })).json;
    expect(audit.map((e: { action: string; detail: unknown }) => [e.action, e.detail])).toEqual([
      ["space.timezone", { from: "UTC", to: "Europe/Lisbon" }],
      ["space.rename", { from: "Mom's home", to: "The Smiths" }],
    ]);
    // Saving the same values again changes (and logs) nothing.
    expectStatus(await patch(mom.token, { name: "The Smiths" }), 200);
    expect((await s.http("/space/audit", { token: mom.token })).json).toHaveLength(2);
  });

  it("only guardians in a home; only the owner and admins in a team", async () => {
    const mom = await s.person("mom", "Mom");
    const dad = await member(mom.household.id, "Dad", "contact");
    expectStatus(await patch(dad, { name: "Dad's place" }), 403);
    const olga = await s.person("olga", "Olga", "team");
    const ada = await member(olga.household.id, "Ada", "guardian");
    const ben = await member(olga.household.id, "Ben", "contact");
    expectStatus(await patch(ben, { timeZone: "Asia/Tokyo" }), 403);
    expectStatus(await patch(ada, { timeZone: "Asia/Tokyo" }), 200);
    expectStatus(await patch(olga.token, { name: "Acme" }), 200);
    // Nobody changed anything they weren't allowed to.
    const homes = await s.http("/me", { token: mom.token });
    expect(homes.json.household).toMatchObject({ name: "Mom's home", timeZone: "UTC" });
  });

  it("says what to fix", async () => {
    const mom = await s.person("mom", "Mom");
    const bad = async (body: unknown) => {
      const r = await patch(mom.token, body);
      expectStatus(r, 400);
      return r.json.error as string;
    };
    expect(await bad({ timeZone: "Mars/Olympus" })).toBe(
      "Use a time zone like America/New_York or Europe/London.",
    );
    expect(await bad({ name: "   " })).toMatch(/^Name/);
    expect(await bad({ name: "x".repeat(65) })).toMatch(/^Name can be at most 64 characters/);
    expect(await bad({})).toBe("Nothing to change.");
    const me = await s.http("/me", { token: mom.token });
    expect(me.json.household).toMatchObject({ name: "Mom's home", timeZone: "UTC" });
  });

  it("phones get the new clock and quiet hours at once, and the next quiet change moves", async () => {
    const mom = await s.person("mom", "Mom");
    // Quiet on Mondays 06:00-08:00. At noon UTC it isn't quiet in UTC...
    expectStatus(
      await s.http("/quiet-hours", {
        method: "PUT",
        token: mom.token,
        body: { rules: [{ days: [1], start: "06:00", end: "08:00" }] },
      }),
      204,
    );
    const p = await s.pairDevice(mom.token, "Kid phone");
    if (!p.deviceId || !p.key) throw new Error("pairing failed");
    const phone = await s.connectDevice(p.deviceId, p.key.pair);
    expect(phone.all("config").at(-1)).toMatchObject({ quiet: false, utcOffsetMin: 0 });
    const configs = phone.all("config").length;
    // ...but in New York it's 07:00 now (UTC-5 in early March): quiet until 08:00.
    expectStatus(await patch(mom.token, { timeZone: "America/New_York" }), 200);
    await until(() => phone.all("config").length > configs);
    expect(phone.all("config").at(-1)).toMatchObject({
      quiet: true,
      quietUntil: "08:00",
      utcOffsetMin: -300,
      now: NOON_MONDAY,
    });
    // The hub's alarm follows the new zone: at 08:00 New York (13:00 UTC) quiet ends.
    s.timers.advance(60 * 60_000 + 1000);
    await until(() => phone.all("config").at(-1)?.quiet === false);
  });

  it("a rename reaches the phones' owner line", async () => {
    const mom = await s.person("mom", "Mom");
    const p = await s.pairDevice(mom.token, "Kid phone");
    if (!p.deviceId || !p.key) throw new Error("pairing failed");
    const phone = await s.connectDevice(p.deviceId, p.key.pair);
    expectStatus(await patch(mom.token, { name: "The Smiths" }), 200);
    await until(() => phone.all("config").at(-1)?.owner?.space === "The Smiths");
  });
});
