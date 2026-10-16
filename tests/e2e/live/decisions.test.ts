// Four screens end to end on this machine (a self-hosted server, browser phones and the companion
// in headless Chromium):
//
// - A kids' phone's Call activity on its Manage page: a call refused (not on its list) and one
//   out that couldn't ring anyone, in plain words.
// - Dad is removed: his own phone stays under "Phones of people who left" as "Dad's desk (Dad
//   left)", and the phone itself shows DAD LEFT.
// - An add-on's Test connection: "Answered in … ms".
// - A share Dad held stops working: under Shared with you, with why and Give it back.
//
//   OLP_DECISIONS_E2E=1 PLAYWRIGHT_CORE=/path/to/playwright-core [CHROME=…] \
//     [OLP_DECISIONS_SHOTS=dir] npx vitest run tests/e2e/live/decisions.test.ts
//
// OLP_ADDON_NO_BUILD=1 reuses the last web build.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fromBase64Url, toBase64Url } from "@openloungephone/protocol";
import { afterAll, beforeAll, expect, it, onTestFailed } from "vitest";
import { reportLogs } from "../procs.ts";
import { socket } from "../scenario.ts";
import { api, type Person, signUp } from "../twoServers.ts";
import { AddonLab } from "./addonKit.ts";
import { Companion, Phone, until } from "./browser.ts";

const ON = process.env.OLP_DECISIONS_E2E === "1";
const SHOTS = process.env.OLP_DECISIONS_SHOTS;
const lab = new AddonLab();

beforeAll(async () => {
  if (ON) await lab.start();
}, 180_000);
afterAll(async () => {
  if (ON) await lab.stop();
});

async function shot(page: Companion["page"], name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function phoneOf(who: Person, profile: string, kind: "kids" | "personal", body: object) {
  const phone = new Phone(lab.server.origin, profile);
  await phone.open(lab.browser, kind);
  const { pairing } = await phone.facts();
  const paired = await api(who, "/devices/pair", { body: { code: pairing, ...body } });
  expect(paired.status, JSON.stringify(paired.json)).toBe(201);
  return { phone, deviceId: await phone.authed() };
}

/** An add-on linked to `who` as "seat", signed in and answering tests by itself. */
async function seatOf(who: Person) {
  const ws = lab.server.base.replace(/^http/, "ws");
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = toBase64Url(
    new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)),
  );
  const hello = {
    t: "hello",
    proto: 1,
    model: "addon",
    fw: "seat/1.4",
    buttons: 1,
    display: "none",
  };
  const pairing = await socket(`${ws}/ws/device`);
  pairing.send(hello);
  pairing.send({ t: "pair.begin", kind: "addon", publicKey });
  const { code } = await pairing.next("pair.code");
  const linked = await api(who, "/addons/link", { body: { code, name: "seat" } });
  expect(linked.status, JSON.stringify(linked.json)).toBe(201);
  const { deviceId } = await pairing.next("pair.done");
  pairing.ws.close();
  const addon = await socket(`${ws}/ws/device?device=${deviceId}`);
  addon.ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.t === "addon.test") {
      addon.send({ t: "addon.test.ok", testId: m.testId, version: "seat/1.4", uptimeS: 7200 });
    }
  });
  addon.send({ ...hello, deviceId: deviceId as string });
  const { nonce } = await addon.next("auth.challenge");
  const sig = await crypto.subtle.sign("Ed25519", keys.privateKey, fromBase64Url(nonce as string));
  addon.send({ t: "auth.proof", sig: toBase64Url(new Uint8Array(sig)) });
  await addon.next("config");
  addon.send({ t: "addon.shares", shares: [{ id: "bookclub", label: "Book club" }] });
  return { id: linked.json.id as string, addon };
}

it.skipIf(!ON)(
  "call activity, phones of people who left, Test connection and stopped shares on screen",
  async () => {
    onTestFailed(() => reportLogs(lab.logs, "the decisions scenario failed"));
    const mom = await signUp(lab.server, "mom", "Mom");
    const dadHome = await signUp(lab.server, "dad", "Dad");
    const invite = await api(mom, "/invites", { body: { name: "Dad", role: "contact" } });
    expect(invite.status, JSON.stringify(invite.json)).toBe(201);
    const joined = await api(dadHome, "/invites/accept", { body: { token: invite.json.token } });
    expect(joined.status, JSON.stringify(joined.json)).toBe(201);
    const dad: Person = { ...dadHome, householdId: mom.householdId };
    await api(dad, "/me/household", { method: "PUT", body: { householdId: mom.householdId } });
    const dadHere = (await api(mom, "/users")).json.find((u: { name: string }) => u.name === "Dad");

    const kid = await phoneOf(mom, "kid", "kids", { name: "Kid phone" });
    const desk = await phoneOf(dad, "dads", "personal", { name: "Dad's desk", forMe: true });

    // Dad (not on the kid's phone's list) calls it: refused. The kid presses an empty key.
    const ws = lab.server.base.replace(/^http/, "ws");
    const dadApp = await socket(`${ws}/ws/app`);
    dadApp.send({ t: "app.hello", proto: 1, token: dad.token });
    await dadApp.next("app.ready");
    dadApp.send({ t: "call.dial", deviceId: kid.deviceId });
    await until(
      "Dad's call refused",
      async () => {
        const m = await dadApp.next("call.state");
        return m.state === "ended" ? m : undefined;
      },
      10_000,
    );
    dadApp.ws.close();
    // The kid calls Mom (key 1) while none of her apps is open: nobody to ring.
    await kid.phone.hook();
    await kid.phone.press("1");
    await until("the call out logged", async () => {
      const r = await api(mom, `/devices/${kid.deviceId}/calls`);
      return r.json.calls.length === 2 ? true : undefined;
    });
    await kid.phone.hook();

    // Mom's add-on, with a share for Dad; then Mom removes Dad from her home.
    const seat = await seatOf(mom);
    await until("the share is offered", async () => {
      const r = await api(mom, "/addons");
      return r.json.addons[0]?.shares?.length ? true : undefined;
    });
    const given = await api(mom, `/addons/${seat.id}/shares/bookclub/grants`, {
      body: { to: `user:${dadHere.id}` },
    });
    expect(given.status, JSON.stringify(given.json)).toBe(201);
    const removed = await api(mom, `/users/${dadHere.id}`, { method: "DELETE" });
    expect(removed.status, JSON.stringify(removed.json)).toBe(200);
    await until("the desk phone says DAD LEFT", async () =>
      ((await desk.phone.page.locator(".display").getAttribute("aria-label")) ?? "").includes(
        "DAD LEFT",
      )
        ? true
        : undefined,
    );

    const app = new Companion(lab.server.origin, "mom");
    await app.open(lab.browser);
    await app.resume(mom.token);
    const page = app.page;
    // Home: Dad's desk stays, labelled.
    await page.getByRole("heading", { name: "Phones of people who left" }).waitFor();
    await page.getByText("Dad's desk (Dad left)", { exact: true }).waitFor();
    await shot(page, "1-phones-of-people-who-left");

    // The kid's phone: Call activity.
    await page
      .locator("li.card.device", { hasText: "Kid phone" })
      .getByRole("button", { name: "Manage" })
      .click();
    const activity = page.getByRole("region", { name: "Call activity" });
    await activity.getByText("Dad tried to call").waitFor();
    await activity.getByText("Not on the phone's list").waitFor();
    await activity.getByText("Tried to call Mom").waitFor();
    await activity.getByText("Mom couldn't be reached").waitFor();
    await shot(page, "2-call-activity");
    await page.getByRole("button", { name: "← Back" }).first().click();

    // The add-on: Test connection.
    await app.tab("Add-ons");
    await page.getByRole("button", { name: "Test connection" }).click();
    await page.getByText(/^Answered in \d+ ms · seat\/1\.4 · up 2 hours\.$/).waitFor();
    await shot(page, "3-test-connection");

    // Dad's side: the share stopped, with why, and Give it back.
    const dadsApp = new Companion(lab.server.origin, "dad");
    await dadsApp.open(lab.browser);
    await dadsApp.resume(dad.token);
    await dadsApp.tab("Add-ons");
    await dadsApp.page.getByText("Stopped: you're no longer connected with Mom.").waitFor();
    await shot(dadsApp.page, "4-stopped-share");
    dadsApp.page.on("dialog", (d: { accept(): Promise<void> }) => void d.accept());
    await dadsApp.page.getByRole("button", { name: "Give it back" }).click();
    await dadsApp.page.getByText("You gave Book club back.").waitFor();
    seat.addon.ws.close();
  },
  240_000,
);
