// What exists shows in the app, end to end on this machine: a self-hosted server, browser phones
// of every kind and the companion in headless Chromium.
//
// - Home: two phones of mine both listed, the kid's phone, Dad's own phone under People's own
//   phones, and the Lounge phone with Manage (its phone page opens).
// - Operator: the This server card in plain words (and no secret), the suspended list with
//   Unsuspend.
// - Workplace: searching the directory doesn't hide anyone from the admin's extension list.
//
//   OLP_VISIBILITY_E2E=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=…] \
//     [OLP_VISIBILITY_SHOTS=dir] npx vitest run tests/e2e/live/visibility.test.ts
//
// OLP_ADDON_NO_BUILD=1 reuses the last web build.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, openSqlite } from "@openloungephone/db/node";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { reportLogs } from "../procs.ts";
import { api, operatorSeed, type Person, signUp } from "../twoServers.ts";
import { AddonLab } from "./addonKit.ts";
import { Companion, Phone, until } from "./browser.ts";

const ON = process.env.OLP_VISIBILITY_E2E === "1";
const SHOTS = process.env.OLP_VISIBILITY_SHOTS;
const lab = new AddonLab();
const TURN_SECRET = "turn-secret-never-shown";
let op: Awaited<ReturnType<typeof operatorSeed>>;

beforeAll(async () => {
  if (!ON) return;
  op = await operatorSeed("boss");
  await lab.start(
    // A TURN secret without TURN_URLS: still "not set up" (and the secret never shows).
    { OPERATORS: op.id, TURN_SECRET, FAIR_USE: "hub" },
    (dir) => {
      const { db } = openSqlite(join(dir, "openloungephone.sqlite"));
      migrate(db);
      for (const statement of op.sql) db.exec(statement);
      db.close();
    },
  );
}, 180_000);
afterAll(async () => {
  if (ON) await lab.stop();
});

async function shot(page: Companion["page"], name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** A browser phone of `kind`, paired by `who` with `body`; answers its id. */
async function phoneOf(
  who: Person,
  profile: string,
  kind: "kids" | "lounge" | "personal",
  body: Record<string, unknown>,
) {
  const phone = new Phone(lab.server.origin, profile);
  await phone.open(lab.browser, kind);
  const { pairing } = await phone.facts();
  const paired = await api(who, "/devices/pair", { body: { code: pairing, ...body } });
  expect(paired.status, JSON.stringify(paired.json)).toBe(201);
  return phone.authed();
}

it.skipIf(!ON)(
  "every phone shows on Home; the operator sees how the server is set up",
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the visibility scenario failed"));
    const mom = await signUp(lab.server, "mom", "Mom");
    const dadHome = await signUp(lab.server, "dad", "Dad");
    const invite = await api(mom, "/invites", { body: { name: "Dad", role: "contact" } });
    expect(invite.status, JSON.stringify(invite.json)).toBe(201);
    const joined = await api(dadHome, "/invites/accept", { body: { token: invite.json.token } });
    expect(joined.status, JSON.stringify(joined.json)).toBe(201);
    const dad: Person = { ...dadHome, householdId: mom.householdId };
    await api(dad, "/me/household", { method: "PUT", body: { householdId: mom.householdId } });

    await phoneOf(mom, "desk", "personal", { name: "Desk", forMe: true });
    await phoneOf(mom, "den", "personal", { name: "Den", forMe: true });
    await phoneOf(mom, "kid", "kids", { name: "Kid phone" });
    const lobby = await phoneOf(mom, "lobby", "lounge", { name: "Lobby", mode: "lounge" });
    await phoneOf(dad, "dads", "personal", { name: "Dad's desk", forMe: true });

    // Home: each phone in its list, none missing.
    const app = new Companion(lab.server.origin, "mom");
    await app.open(lab.browser);
    await app.resume(mom.token);
    const page = app.page;
    const myPhones = page.locator("#my-phone");
    await myPhones.getByText("My phones", { exact: true }).waitFor();
    for (const name of ["Desk", "Den"]) await myPhones.getByText(name, { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Household phones" }).waitFor();
    await page.getByText("Kid phone", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "People's own phones" }).waitFor();
    await page.getByText("Dad's desk", { exact: true }).waitFor();
    const lounge = page.locator("section", {
      has: page.getByRole("heading", { name: "Lounge phones" }),
    });
    await lounge.getByText("Lobby", { exact: true }).waitFor();
    await shot(page, "1-home-phones");
    await lounge.getByRole("button", { name: "Manage" }).click();
    await page.getByLabel("Phone name").waitFor();
    expect(await page.getByLabel("Phone name").inputValue()).toBe("Lobby");
    await page.getByRole("button", { name: "Remove and wipe" }).waitFor();
    expect(page.url()).not.toContain("error");
    void lobby;

    // The operator: This server, in plain words.
    const boss: Person = { server: lab.server, token: op.token, householdId: "", address: "" };
    const space = await api(boss, "/spaces", { body: { name: "Ops", type: "home" } });
    expect(space.status, JSON.stringify(space.json)).toBe(201);
    const suspend = await api(boss, `/admin/accounts?handle=dad`);
    expect(suspend.status).toBe(200);
    expect(
      (await api(boss, `/admin/accounts/${suspend.json.id}/suspend`, { body: { suspended: true } }))
        .status,
    ).toBe(204);
    const opApp = new Companion(lab.server.origin, "boss");
    await opApp.open(lab.browser);
    await opApp.resume(op.token);
    await opApp.tab("Operator");
    const card = opApp.page.locator("section.this-server");
    await card.getByRole("heading", { name: "This server" }).waitFor();
    const row = async (label: string) =>
      (
        await card
          .locator(".setting-row", { has: opApp.page.getByText(label, { exact: true }) })
          .innerText()
      ).trim();
    expect(await row("Sign-up")).toContain("Open to anyone");
    expect(await row("Add-ons")).toContain("On");
    expect(await row("Fair use")).toContain("1,000 call minutes a month");
    expect(await row("Call relay (TURN)")).toContain("Not set up");
    expect(await row("Rooms' audio")).toContain("Direct between people");
    expect(await row("Operators")).toContain("@boss");
    expect(await row("Public address")).toContain(lab.server.origin);
    expect(await card.innerText()).not.toContain(TURN_SECRET);
    await shot(opApp.page, "2-operator-this-server");
    // Suspended accounts are listed, each with its undo.
    const suspended = opApp.page.locator(".card", {
      has: opApp.page.getByRole("heading", { name: "Suspended" }),
    });
    await suspended.getByText("@dad").waitFor();
    await suspended.getByRole("button", { name: "Unsuspend" }).click();
    await until(
      "Dad unsuspended",
      async () => !(await api(boss, "/admin/accounts?handle=dad")).json.suspended,
    );
    await opApp.page.getByRole("heading", { name: "Suspended" }).waitFor({ state: "detached" });
    await shot(opApp.page, "3-operator-unsuspended");

    // A team: searching the directory doesn't hide people from the admin's extension list.
    const team = await api(mom, "/spaces", { body: { name: "Acme", type: "team" } });
    expect(team.status, JSON.stringify(team.json)).toBe(201);
    const momTeam: Person = { ...mom, householdId: team.json.household.id };
    await api(momTeam, "/me/household", {
      method: "PUT",
      body: { householdId: team.json.household.id },
    });
    const inv = await api(momTeam, "/invites", { body: { name: "Dad", role: "contact" } });
    const acc = await api(dad, "/invites/accept", { body: { token: inv.json.token } });
    expect(acc.status, JSON.stringify(acc.json)).toBe(201);
    const dadInTeam = acc.json.user.id as string;
    expect(
      (
        await api(momTeam, "/extensions/201", {
          method: "PUT",
          body: { kind: "user", targetId: dadInTeam },
        })
      ).status,
    ).toBe(204);
    await app.resume(mom.token);
    await app.tab("Directory");
    await page.getByRole("heading", { name: "Admin" }).waitFor();
    await page.getByPlaceholder("Search people, phones, groups or extensions").fill("Mom");
    await until("search applied", async () => (await page.getByText("Ext. 201").count()) === 0);
    await page.locator("li", { hasText: "201 · Dad" }).waitFor();
    await shot(page, "4-directory-search-admin");
  },
  240_000,
);
