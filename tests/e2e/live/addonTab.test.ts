// The Add-ons tab end to end, entirely on this machine: a self-hosted server with add-ons on,
// Python add-ons from sdk/python/examples as processes, the companion at phone width and a
// browser phone, all in headless Chromium with real WebRTC audio.
//
// 1. Link → key → call: the echo add-on is linked in the app and put on a key of the browser
//    phone, which calls it, in exactly TARGET_STEPS steps (an added step fails the test). Its page
//    says what it does, from what it said about itself (no add-on-specific app code).
// 2. A one-way "radio" (examples/radio.py, three calls at once) plays to three listeners at the
//    same time; a fourth hears busy.
// 3. A holder sees what the add-on learns, stops its calls and gives the share back.
//
//   OLP_ADDON_E2E=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=…] [AXE_CORE=…/axe.min.js] \
//     [OLP_ADDON_SHOTS=dir] npx vitest run tests/e2e/live/addonTab.test.ts
//
// AXE_CORE runs axe on every screen (no serious or critical issues allowed). Needs the bridge's
// venv (see addon.test.ts; or OLP_ADDON_PYTHON).
import type { Page } from "playwright-core";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { reportLogs } from "../procs.ts";
import { api, signUp } from "../twoServers.ts";
import { AddonLab, befriend, Steps, shot } from "./addonKit.ts";
import { Companion, Phone, pcConnected, until } from "./browser.ts";

const ON = process.env.OLP_ADDON_E2E === "1";
/** Link → call from the browser phone, counting every click and field (it was 14 before). */
const TARGET_STEPS = 8;
const lab = new AddonLab();

beforeAll(async () => {
  if (ON) await lab.start();
}, 180_000);
afterAll(async () => {
  if (ON) await lab.stop();
});

/** Serious or critical accessibility problems on the page, by axe (when AXE_CORE is given). */
async function axe(page: Page, where: string): Promise<void> {
  const path = process.env.AXE_CORE;
  if (!path) return;
  await page.addScriptTag({ path });
  const found = (await page.evaluate(async () => {
    const w = window as unknown as {
      axe: { run(ctx: unknown, o: unknown): Promise<{ violations: unknown[] }> };
    };
    const r = await w.axe.run(document, { resultTypes: ["violations"] });
    return r.violations;
  })) as { id: string; impact: string; nodes: { target: string[] }[] }[];
  const bad = found.filter((v) => v.impact === "serious" || v.impact === "critical");
  console.log(
    `axe ${where}: ${found.length} issue(s), ${bad.length} serious or critical${
      found.length ? ` (${found.map((v) => `${v.id}/${v.impact}`).join(", ")})` : ""
    }`,
  );
  expect(
    bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
    where,
  ).toEqual([]);
}

async function companion(handle: string, token: string): Promise<Companion> {
  const app = new Companion(lab.server.origin, handle);
  await app.open(lab.browser);
  await app.page.setViewportSize({ width: 390, height: 844 });
  await app.resume(token);
  return app;
}

/** RTP received by the page's newest peer connection (audio from the other side). */
async function inboundBytes(page: Page): Promise<number> {
  return page.evaluate(async () => {
    type Rec = { pc: RTCPeerConnection };
    const pc = (window as unknown as { __olp?: { pcs: Rec[] } }).__olp?.pcs.at(-1)?.pc;
    if (!pc) return 0;
    let bytes = 0;
    (await pc.getStats()).forEach((r: { type: string; kind?: string; bytesReceived?: number }) => {
      if (r.type === "inbound-rtp" && r.kind === "audio") bytes = r.bytesReceived ?? 0;
    });
    return bytes;
  });
}

it.skipIf(!ON)(
  `link → put on a key → call from the browser phone in ${TARGET_STEPS} steps`,
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the Add-ons tab scenario failed"));
    const jo = await signUp(lab.server, "jo", "Jo");
    const phone = new Phone(lab.server.origin, "desk");
    await phone.open(lab.browser, "personal");
    const pairing = (await phone.facts()).pairing;
    const paired = await api(jo, "/devices/pair", {
      body: { code: pairing, name: "Desk", forMe: true },
    });
    expect(paired.status).toBe(201);
    await phone.authed();
    const app = await companion("jo", jo.token);
    const page = app.page;
    const echo = lab.python("echo", lab.keyFile("echo"), ["--share", "bookclub:Book club"]);
    const code = await lab.code(echo);
    await shot(page, "after-0-home");

    const steps = new Steps();
    await app.tab("Add-ons");
    steps.step("Add-ons tab");
    await page.getByRole("heading", { name: "Add-ons", exact: true }).waitFor();
    await shot(page, "after-1-addons-empty");
    await axe(page, "Add-ons (none yet)");
    await page.getByRole("button", { name: "Link an add-on" }).click();
    steps.step("Link an add-on");
    await page.getByLabel("Code").fill(code);
    steps.step("type the code");
    await page.getByLabel("Name").fill("echo");
    steps.step("type a name");
    await shot(page, "after-2-link-form");
    await axe(page, "Link an add-on");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    steps.step("Link");
    const address = `jo+echo@${lab.host}`;
    await page.getByText(`Linked. echo is at ${address}.`).waitFor();
    // Put on a key is open, with the phone and its first free key chosen.
    const put = page.getByRole("button", { name: "Put on key 1" });
    await put.waitFor({ timeout: 10_000 });
    await shot(page, "after-3-linked-put-on-key");
    await axe(page, "Linked: put on a key");
    await put.click();
    steps.step("Put on key 1");
    await page.getByText("echo is on key 1 of Desk.").waitFor();
    // Its page says what it does, from what it said (the echo example's addon.about).
    await until(
      "online, with what it does",
      async () => {
        const text = await page.locator(".addon-page").innerText();
        return text.includes("Online") && text.includes("Plays back what you say");
      },
      25_000,
      500,
    );
    const said = await page.locator(".addon-page").innerText();
    for (const line of [
      "“Plays back what you say, half a second later.”",
      "You can call it.",
      "It never calls you.",
      "It listens during calls. It says it keeps nothing afterwards.",
      "It responds to keys you press during a call.",
      "It offers parts of itself to share with people you choose.",
      "It learns the name and address of whoever calls it.",
      "Book club",
    ]) {
      expect(said).toContain(line);
    }
    await shot(page, "after-4-addon-page");
    await axe(page, "An add-on's page");

    // The browser phone: lift the handset, press 1.
    await new Promise((r) => setTimeout(r, 1000));
    await phone.hook();
    steps.step("lift the handset");
    await phone.press("1");
    steps.step("press 1");
    await until("the call at the add-on", () => echo.text.includes("call from Jo"), 20_000);
    await until(
      "the phone showing it as an add-on",
      async () =>
        /ADD-ON/.test((await phone.page.locator(".display").getAttribute("aria-label")) ?? ""),
      10_000,
    );
    await phone.page.setViewportSize({ width: 390, height: 844 });
    await shot(phone.page, "after-5-phone-calling");
    console.log(`AFTER (a) link → key → call: ${steps.count} steps: ${steps.done.join(" / ")}`);
    expect(steps.count).toBe(TARGET_STEPS);
    await phone.hook();

    // Add to contacts: on Home, one tap to call.
    await page.getByRole("button", { name: "Add to contacts" }).first().click();
    await page.getByText("echo is in your contacts on Home.").waitFor();
    await app.tab("Home");
    await page.locator(".addon-contacts").getByText("echo").waitFor();
    await shot(page, "after-6-home-contacts");
    await axe(page, "Home with contacts");
  },
  240_000,
);

it.skipIf(!ON)(
  "a one-way radio plays to three listeners at once; a fourth hears busy",
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the radio scenario failed"));
    const host = lab.host;
    const ra = await signUp(lab.server, "ra", "Ra");
    const radio = lab.python("radio", lab.keyFile("radio"), ["--lines", "3"], "radio");
    const linked = await lab.link(ra, radio, "radio");
    const people = [];
    for (const [h, n] of [
      ["li", "Li"],
      ["mo", "Mo"],
      ["ny", "Ny"],
    ] as const) {
      const p = await signUp(lab.server, h, n);
      await befriend(ra, p);
      people.push(p);
    }
    await until(
      "its share",
      async () => (await api(ra, "/addons")).json.addons[0]?.shares.length === 1,
      10_000,
      200,
    );
    for (const ref of (await api(ra, "/addons/people")).json as { ref: string }[]) {
      const g = await api(ra, `/addons/${linked.id}/shares/listen/grants`, {
        body: { to: ref.ref },
      });
      expect(g.status).toBe(201);
    }
    // Its owner and two holders call; each hears it.
    const owner = await companion("ra", ra.token);
    const listeners: Companion[] = [owner];
    for (const p of people) listeners.push(await companion(p.address.split("@")[0] ?? "", p.token));
    const callFrom = async (c: Companion, own: boolean) => {
      await c.tab("Add-ons");
      const before = await c.pcCount();
      const where = own ? c.page.locator(".addon-page") : c.page.locator("li.held").first();
      await where.getByRole("button", { name: "Call" }).first().click({ timeout: 20_000 });
      return before;
    };
    const live: Companion[] = [];
    for (const [i, c] of listeners.slice(0, 3).entries()) {
      const before = await callFrom(c, i === 0);
      await pcConnected(c.page, before, 30_000);
      live.push(c);
    }
    await shot(listeners[1]?.page as Page, "after-7-radio-listener");
    expect(radio.text).toMatch(/\(3 now\)/);
    // All three hear sound at the same time.
    const a = await Promise.all(live.map((c) => inboundBytes(c.page)));
    await new Promise((r) => setTimeout(r, 2000));
    const b = await Promise.all(live.map((c) => inboundBytes(c.page)));
    const got = b.map((x, i) => x - (a[i] ?? 0));
    console.log(`radio: bytes in 2 s per listener: ${got.join(", ")}`);
    for (const g of got) expect(g).toBeGreaterThan(4000);
    // The fourth: busy.
    const fourth = listeners[3] as Companion;
    await callFrom(fourth, false);
    await fourth.page.locator(".overlay-ended").waitFor({ timeout: 20_000 });
    expect(await fourth.ended()).toMatch(/busy/i);
    for (const c of live) await c.hangUp();
    expect(host).toBeTruthy();
  },
  240_000,
);

it.skipIf(!ON)(
  "a holder: what it learns, stop its calls, give it back",
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the holder scenario failed"));
    const kai = await signUp(lab.server, "kai", "Kai");
    const zo = await signUp(lab.server, "zo", "Zo");
    await befriend(kai, zo);
    const echo = lab.python("echo", lab.keyFile("echo2"), ["--share", "garden:Garden"], "echo2");
    const linked = await lab.link(kai, echo, "notes");
    await until(
      "its share",
      async () => (await api(kai, "/addons")).json.addons[0]?.shares.length === 1,
      10_000,
      200,
    );
    // Kai gives it in the app: the dialog says what it learns about Zo.
    const owner = await companion("kai", kai.token);
    owner.page.on("dialog", (d: { accept(): Promise<void> }) => void d.accept());
    await owner.tab("Add-ons");
    await owner.page.getByRole("button", { name: "Give to…" }).click();
    await owner.page.getByLabel("Give Garden to").selectOption({ label: `Zo (${zo.address})` });
    await owner.page
      .getByText("When Zo calls, notes learns their name and address, and can hear what they say.")
      .waitFor();
    await shot(owner.page, "after-8-give-share");
    await axe(owner.page, "Give to…");
    await owner.page.getByRole("button", { name: "Give", exact: true }).click();
    await owner.page.getByText("Garden is shared with Zo.").waitFor();

    const holder = await companion("zo", zo.token);
    holder.page.on("dialog", (d: { accept(): Promise<void> }) => void d.accept());
    await holder.tab("Add-ons");
    const card = holder.page.locator("li.held", { hasText: "Kai's notes · Garden" });
    await card.waitFor({ timeout: 20_000 });
    expect(await card.innerText()).toContain(
      "When you call, notes learns your name and address, and can hear what you say.",
    );
    await shot(holder.page, "after-9-holder");
    await axe(holder.page, "Shared with you");
    await card.getByRole("button", { name: "Stop its calls" }).click();
    await holder.page.getByText("notes can't call you now. You can still call it.").waitFor();
    expect((await api(zo, "/addons/shared")).json.held[0].muted).toBe(true);
    await card.getByRole("button", { name: "Give it back" }).click();
    await holder.page.getByText("You gave Garden back.").waitFor();
    expect((await api(zo, "/addons/shared")).json.held).toEqual([]);
    expect((await api(kai, `/addons`)).json.addons[0].shares[0].holders).toEqual([]);
    expect(linked.address).toContain("kai+notes@");
  },
  240_000,
);
