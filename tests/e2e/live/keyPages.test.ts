// Speed-dial pages end to end, entirely on this machine: a self-hosted server, the companion's
// key editor (Page 1, Add page, Page 2, Move) and a browser phone paging with BACK, in headless
// Chromium.
//
//   OLP_KEY_PAGES_E2E=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=…] \
//     [OLP_KEY_PAGES_SHOTS=dir] npx vitest run tests/e2e/live/keyPages.test.ts
//
// OLP_ADDON_NO_BUILD=1 reuses the last web build.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { reportLogs } from "../procs.ts";
import { api, signUp } from "../twoServers.ts";
import { AddonLab } from "./addonKit.ts";
import { Companion, Phone, until } from "./browser.ts";

const ON = process.env.OLP_KEY_PAGES_E2E === "1";
const SHOTS = process.env.OLP_KEY_PAGES_SHOTS;
const lab = new AddonLab();

beforeAll(async () => {
  if (ON) await lab.start();
}, 180_000);
afterAll(async () => {
  if (ON) await lab.stop();
});

async function shot(page: Phone["page"], name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** What the phone's screen says (its status lines, as the display's label). */
const screen = (phone: Phone) =>
  phone.page.evaluate(() => document.querySelector(".display")?.getAttribute("aria-label") ?? "");

it.skipIf(!ON)(
  "the key editor's pages, and BACK turning them on the browser phone",
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the key pages scenario failed"));
    const mom = await signUp(lab.server, "mom", "Mom");
    const phone = new Phone(lab.server.origin, "kid");
    await phone.open(lab.browser, "kids");
    const { pairing } = await phone.facts();
    const paired = await api(mom, "/devices/pair", { body: { code: pairing, name: "Kid phone" } });
    expect(paired.status, JSON.stringify(paired.json)).toBe(201);
    const deviceId = await phone.authed();
    // Somewhere to call: rooms of the space, on the phone's list.
    const rooms: { id: string; name: string }[] = [];
    for (const name of ["Den", "Attic"]) {
      const r = await api(mom, "/rooms", { body: { name, kind: "party" } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const on = await api(mom, `/devices/${deviceId}/rooms/${r.json.id}`, {
        method: "PUT",
        body: { label: name },
      });
      expect(on.status, JSON.stringify(on.json)).toBe(200);
      rooms.push({ id: on.json.id, name });
    }
    const [den, attic] = rooms as [(typeof rooms)[0], (typeof rooms)[0]];

    // The companion: one page looks as before (no page titles), with Add page under it.
    const app = new Companion(lab.server.origin, "mom");
    await app.open(lab.browser);
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.resume(mom.token);
    const page = app.page;
    await page.getByRole("button", { name: "Manage" }).first().click();
    await page.getByRole("heading", { name: "Keys" }).waitFor();
    expect(await page.getByText("Page 1", { exact: true }).count()).toBe(0);
    await page.getByLabel("Key 2", { exact: true }).selectOption({ label: "Den" });
    await page.getByRole("button", { name: "Add page" }).click();
    await page.getByText("Page 2", { exact: true }).waitFor();
    await shot(page, "1-editor-two-pages");
    await page.getByLabel("Page 2, key 3", { exact: true }).selectOption({ label: "Attic" });
    await until("Attic on page 2", async () => {
      const c = await api(mom, `/devices/${deviceId}/contacts`);
      return c.json.buttons["12"] === attic.id;
    });
    // Move Den from page 1, key 2 to page 2, key 5.
    const move = page.locator("form", { hasText: "Move someone to another key" });
    await move
      .getByLabel("Who to move", { exact: true })
      .selectOption({ label: "Den (page 1, key 2)" });
    await move.getByLabel("Move to page", { exact: true }).selectOption("2");
    await move.getByLabel("Move to key", { exact: true }).selectOption({ label: "5 (free)" });
    await move.getByRole("button", { name: "Move" }).click();
    await until("Den moved", async () => {
      const c = await api(mom, `/devices/${deviceId}/contacts`);
      return c.json.buttons["14"] === den.id && !c.json.buttons["1"] ? c : undefined;
    });
    await until(
      "the editor shows Den on page 2, key 5",
      async () => (await page.getByLabel("Page 2, key 5", { exact: true }).inputValue()) === den.id,
    );
    await shot(page, "2-editor-moved");

    // The phone: page 1 with the handset up, BACK to page 2, a digit there, back to page 1.
    await until("the phone has page 2", () => {
      const c = phone.lastFrame("config") as { pages?: { page: number }[] } | undefined;
      return c?.pages?.some((p) => p.page === 2);
    });
    await phone.hook();
    await until("page 1/2", async () => (await screen(phone)).includes("PAGE 1/2"));
    expect(await screen(phone)).toContain("BACK: NEXT PAGE");
    await shot(phone.page, "3-phone-page-1");
    await phone.press("Backspace");
    await until("page 2/2", async () => (await screen(phone)).includes("PAGE 2/2"));
    expect(JSON.parse((await phone.facts()).state)).toEqual({ kind: "offhook", page: 2 });
    await shot(phone.page, "4-phone-page-2");
    // Wraps from the last page to the first.
    await phone.press("Backspace");
    await until("back on page 1", async () => (await screen(phone)).includes("PAGE 1/2"));
    await phone.press("Backspace");
    await until("page 2 again", async () => (await screen(phone)).includes("PAGE 2/2"));
    // Key 3 on page 2 is the Attic: the phone joins it.
    const sent = phone.frames.length;
    await phone.press("3");
    await until("joined the Attic", async () => (await phone.kind()) === "inroom");
    expect(phone.frames.slice(sent).find((f) => f.t === "room.state")).toBeTruthy();
    await shot(phone.page, "5-phone-in-room");
    // Hang up, lift again: page 1.
    await phone.hook();
    await phone.waitKind("idle");
    await phone.hook();
    await until("page 1 after hanging up", async () => (await screen(phone)).includes("PAGE 1/2"));
    await phone.hook();
  },
  180_000,
);
