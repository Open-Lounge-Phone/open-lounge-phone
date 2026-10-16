// Speed-dial pages (docs/phone-ux.md): ten keys a page, up to ten pages, stored as one index
// ((page - 1) * 10 + slot). Phones that list `key-pages` get the later pages in `config.pages`
// and dial them with `button.page`; every key follows the same rules as page 1's.
import { encode, MAX_MESSAGE_BYTES, type ServerToDevice } from "@openloungephone/protocol";
import { describe, expect, it } from "vitest";
import { linkAddon } from "./addonHarness.ts";
import { fitConfig } from "./hub.ts";
import { expectStatus, type FakeConn, TestServer } from "./testkit.ts";

type Config = Extract<ServerToDevice, { t: "config" }>;
const PAGED = ["key-pages"];

async function setup(env: ConstructorParameters<typeof TestServer>[0] = {}) {
  const s = new TestServer({ publicUrl: "https://a.test", ...env });
  const mom = await s.person("mom", "Mom");
  const kid = await s.pairDevice(mom.token, "Kid phone");
  if (!kid.deviceId || !kid.key) throw new Error("pairing failed");
  const people = [];
  for (const name of ["Ana", "Ben", "Cy"]) {
    const u = await s.store.createUser({ householdId: mom.household.id, name, role: "contact" }, 0);
    const token = await s.store.createSession(u.id, s.timers.now);
    people.push({ ...u, token });
  }
  return { s, mom, kid: { id: kid.deviceId, key: kid.key.pair }, people };
}

async function allow(
  s: TestServer,
  token: string,
  deviceId: string,
  userId: string,
  label: string,
  flags: { deviceCanCall?: boolean; bypassQuietHours?: boolean } = {},
) {
  expectStatus(
    await s.http(`/devices/${deviceId}/contacts/${userId}`, {
      method: "PUT",
      token,
      body: {
        label,
        canCallDevice: true,
        deviceCanCall: flags.deviceCanCall ?? true,
        bypassQuietHours: flags.bypassQuietHours ?? false,
      },
    }),
    204,
  );
}

const putKey = (s: TestServer, token: string, deviceId: string, index: number, userId: string) =>
  s.http(`/devices/${deviceId}/buttons/${index}`, { method: "PUT", token, body: { userId } });

const lastConfig = (phone: FakeConn) => phone.all("config").at(-1) as Config;

describe("speed-dial pages: storage and the API", () => {
  it("keys 0-99 (ten pages of ten); the contacts list says how many pages", async () => {
    const { s, mom, kid, people } = await setup();
    const ana = people[0] as { id: string };
    await allow(s, mom.token, kid.id, ana.id, "Ana");
    expectStatus(await putKey(s, mom.token, kid.id, 99, ana.id), 204);
    expectStatus(await putKey(s, mom.token, kid.id, 10, ana.id), 204);
    for (const bad of [100, -1, 1.5]) {
      expectStatus(await putKey(s, mom.token, kid.id, bad, ana.id), 400);
    }
    const list = await s.http(`/devices/${kid.id}/contacts`, { token: mom.token });
    expect(list.json.keyPages).toBe(10);
    expect(list.json.buttons).toMatchObject({ "10": ana.id, "99": ana.id });
  });

  it("a server may allow fewer pages", async () => {
    const { s, mom, kid, people } = await setup({ env: { limits: { keyPages: 2 } } });
    const ana = people[0] as { id: string };
    await allow(s, mom.token, kid.id, ana.id, "Ana");
    expectStatus(await putKey(s, mom.token, kid.id, 19, ana.id), 204);
    const res = await putKey(s, mom.token, kid.id, 20, ana.id);
    expectStatus(res, 400);
    expect(res.json.error).toBe("index must be 0-19");
    expect((await s.http(`/devices/${kid.id}/contacts`, { token: mom.token })).json.keyPages).toBe(
      2,
    );
    // …for public lines and add-ons put on a key in one step too.
    const own = await s.pairDevice(mom.token, "Desk", { forMe: true });
    const line = (key: number) =>
      s.http(`/devices/${own.deviceId}/lines`, {
        method: "PUT",
        token: mom.token,
        body: { address: "help@b.example", label: "Help", key },
      });
    expectStatus(await line(25), 400);
    expectStatus(await line(15), 200);
  });
});

describe("speed-dial pages on the phone", () => {
  async function paged() {
    const g = await setup();
    const [ana, ben, cy] = g.people as [
      (typeof g.people)[0],
      (typeof g.people)[0],
      (typeof g.people)[0],
    ];
    for (const p of [ana, ben, cy]) await allow(g.s, g.mom.token, g.kid.id, p.id, p.name);
    expectStatus(await putKey(g.s, g.mom.token, g.kid.id, 1, ana.id), 204);
    expectStatus(await putKey(g.s, g.mom.token, g.kid.id, 13, ben.id), 204); // page 2, key 4
    expectStatus(await putKey(g.s, g.mom.token, g.kid.id, 49, cy.id), 204); // page 5, key 0
    return { ...g, ana, ben, cy };
  }

  it("a phone without key-pages gets page 1 only, exactly as before", async () => {
    const { s, kid, mom } = await paged();
    const phone = await s.connectDevice(kid.id, kid.key);
    const config = lastConfig(phone);
    expect(config.buttons).toEqual([
      { index: 0, label: "Mom" },
      { index: 1, label: "Ana" },
    ]);
    expect(config.pages).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain("Ben");
    // Its keys dial page 1, as always.
    const momApp = await s.connectApp(mom.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 0 });
    await momApp.next("call.ringing");
  });

  it("a phone with key-pages gets the later pages with keys, and dials them", async () => {
    const { s, kid, ben, cy } = await paged();
    const phone = await s.connectDevice(kid.id, kid.key, PAGED);
    const config = lastConfig(phone);
    expect(config.buttons).toEqual([
      { index: 0, label: "Mom" },
      { index: 1, label: "Ana" },
    ]);
    expect(config.pages).toEqual([
      { page: 2, buttons: [{ index: 3, label: "Ben" }] },
      { page: 5, buttons: [{ index: 9, label: "Cy" }] },
    ]);
    const benApp = await s.connectApp(ben.token);
    const cyApp = await s.connectApp(cy.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 3, page: 2 });
    expect((await benApp.next("call.ringing")).from.label).toBe("Kid phone");
    phone.write({ t: "hook", state: "down" });
    phone.write({ t: "call.hangup", callId: (await phone.nextState("ringing")).callId });
    await phone.nextState("ended");
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 9, page: 5 });
    await cyApp.next("call.ringing");
    expect(benApp.all("call.ringing")).toHaveLength(1);
  });

  it("an empty key, a page without keys, or a slot past 9 is refused", async () => {
    const { s, kid, mom, ben } = await paged();
    const phone = await s.connectDevice(kid.id, kid.key, PAGED);
    // Someone on page 3, key 3 (stored 22): a press saying page 2, slot 12 must not reach them.
    const benApp = await s.connectApp(ben.token);
    expectStatus(await putKey(s, mom.token, kid.id, 22, ben.id), 204);
    phone.write({ t: "hook", state: "up" });
    for (const press of [
      { index: 4, page: 2 },
      { index: 0, page: 3 },
      { index: 12, page: 2 },
    ]) {
      phone.write({ t: "button", ...press });
      expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    }
    expect(benApp.all("call.ringing")).toHaveLength(0);
  });

  it("allow-lists and quiet hours decide a later page's keys as page 1's", async () => {
    const { s, mom, kid, ben, cy } = await paged();
    // Ben may call the phone, but the phone may not call Ben: off its pages, refused if pressed.
    await allow(s, mom.token, kid.id, ben.id, "Ben", { deviceCanCall: false });
    // Quiet hours now (Monday noon); Cy may still be called through them.
    expectStatus(
      await s.http("/quiet-hours", {
        method: "PUT",
        token: mom.token,
        body: { rules: [{ days: [1], start: "11:00", end: "13:00" }] },
      }),
      204,
    );
    const phone = await s.connectDevice(kid.id, kid.key, PAGED);
    expect(lastConfig(phone).pages).toEqual([{ page: 5, buttons: [{ index: 9, label: "Cy" }] }]);
    const benApp = await s.connectApp(ben.token);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 3, page: 2 });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    expect(benApp.all("call.ringing")).toHaveLength(0);
    // Quiet hours: Cy is refused too, until the guardians let him through them.
    const cyApp = await s.connectApp(cy.token);
    phone.write({ t: "button", index: 9, page: 5 });
    expect(await phone.nextState("ended")).toMatchObject({ reason: "denied" });
    await allow(s, mom.token, kid.id, cy.id, "Cy", { bypassQuietHours: true });
    phone.write({ t: "button", index: 9, page: 5 });
    await cyApp.next("call.ringing");
  });

  it("kids' phones never get add-ons, on any page; own phones do", async () => {
    const s = new TestServer({ publicUrl: "https://a.test", env: { addons: true } });
    const jesse = await s.person("jesse", "Jesse");
    const seat = await linkAddon(s, jesse);
    const kid = await s.pairDevice(jesse.token, "Kid");
    const put = await s.http(`/devices/${kid.deviceId}/lines`, {
      method: "PUT",
      token: jesse.token,
      body: { address: seat.address, label: "Seat", key: 25 },
    });
    expect(put.status).toBe(400);
    // One that got there anyway is refused when pressed, on page 3 as on page 1.
    const id = await s.store.lines.addToPhone(kid.deviceId as string, seat.address, "Seat");
    await s.store.setButton(kid.deviceId as string, 25, id);
    const kidPhone = await s.connectDevice(
      kid.deviceId as string,
      kid.key?.pair as CryptoKeyPair,
      PAGED,
    );
    kidPhone.write({ t: "hook", state: "up" });
    kidPhone.write({ t: "button", index: 5, page: 3 });
    expect(await kidPhone.nextState("ended")).toMatchObject({
      reason: "denied",
      note: "Kids' phones can't call add-ons",
    });
    // A person's own phone: on page 3, marked as an add-on.
    const own = await s.pairDevice(jesse.token, "Desk", { forMe: true });
    const add = await s.http(`/devices/${own.deviceId}/lines`, {
      method: "PUT",
      token: jesse.token,
      body: { address: seat.address, label: "Seat", key: 25 },
    });
    expectStatus(add, 200);
    const tooFar = await s.http(`/devices/${own.deviceId}/lines`, {
      method: "PUT",
      token: jesse.token,
      body: { address: "help@b.example", label: "Help", key: 100 },
    });
    expectStatus(tooFar, 400);
    const desk = await s.connectDevice(
      own.deviceId as string,
      own.key?.pair as CryptoKeyPair,
      PAGED,
    );
    expect(lastConfig(desk).pages).toEqual([
      { page: 3, buttons: [{ index: 5, label: "Seat", addon: true }] },
    ]);
    desk.write({ t: "hook", state: "up" });
    desk.write({ t: "button", index: 5, page: 3 });
    await seat.conn.next("call.ringing");
  });
});

describe("speed-dial pages within the 16 KiB message", () => {
  it("a hundred keys with long labels fit", async () => {
    const { s, mom, kid } = await setup();
    // 24 three-byte characters a label: as long as a label gets in UTF-8 but for emoji pairs.
    for (let i = 0; i < 100; i++) {
      const u = await s.store.createUser(
        { householdId: mom.household.id, name: `P${i}`, role: "contact" },
        0,
      );
      await s.store.upsertContact(kid.id, {
        id: u.id,
        label: `${String(i).padStart(2, "0")}${"€".repeat(22)}`,
        canCallDevice: true,
        deviceCanCall: true,
        bypassQuietHours: false,
      });
      await s.store.setButton(kid.id, i, u.id);
    }
    const phone = await s.connectDevice(kid.id, kid.key, PAGED);
    const config = lastConfig(phone);
    expect(config.buttons).toHaveLength(10);
    expect(config.pages).toHaveLength(9);
    expect(config.pages?.every((p) => p.buttons.length === 10)).toBe(true);
    const bytes = new TextEncoder().encode(encode(config)).byteLength;
    expect(bytes).toBeGreaterThan(9_000);
    expect(bytes).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("past the budget, the last pages give way first", () => {
    const label = "\u0001".repeat(24); // escaped as \u0001: six bytes a character
    const page = (n: number) => ({
      page: n,
      buttons: Array.from({ length: 10 }, (_, index) => ({ index, label })),
    });
    const big: Config = {
      t: "config",
      buttons: page(1).buttons,
      pages: [2, 3, 4, 5, 6, 7, 8, 9, 10].map(page),
      quiet: false,
    };
    const size = (m: Config) => new TextEncoder().encode(encode(m)).byteLength;
    expect(size(big)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const fit = fitConfig(big);
    expect(size(fit)).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(fit.buttons).toHaveLength(10);
    expect(fit.pages?.map((p) => p.page)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    // Within the budget nothing changes.
    const small: Config = { t: "config", buttons: [], pages: [page(2)], quiet: false };
    expect(fitConfig(small)).toBe(small);
  });
});

describe("speed-dial pages on a Lounge phone", () => {
  it("the signed-in person's desk-phone keys, on their pages", async () => {
    const s = new TestServer({ publicUrl: "https://a.test" });
    const mom = await s.person("mom", "Mom");
    const ana = await s.store.createUser(
      { householdId: mom.household.id, name: "Ana", role: "contact" },
      0,
    );
    const anaApp = await s.connectApp(await s.store.createSession(ana.id, s.timers.now));
    // Mom's own desk phone: Ana on page 2, key 1.
    const desk = await s.pairDevice(mom.token, "Desk", { forMe: true });
    await allow(s, mom.token, desk.deviceId as string, ana.id, "Ana");
    expectStatus(await putKey(s, mom.token, desk.deviceId as string, 10, ana.id), 204);
    // The Lounge phone, showing pages.
    const lobby = await s.pairDevice(mom.token, "Lobby", { kind: "lounge" });
    const phone = await s.connectDevice(
      lobby.deviceId as string,
      lobby.key?.pair as CryptoKeyPair,
      PAGED,
    );
    const { nonce } = await phone.next("lounge.idle");
    const momApp = await s.connectApp(mom.token);
    momApp.write({ t: "lounge.claim", deviceId: lobby.deviceId as string, nonce });
    const { index } = await phone.next("lounge.challenge");
    phone.write({ t: "lounge.press", index });
    await phone.next("lounge.session");
    const config = await phone.next("config");
    expect(config.pages).toEqual([{ page: 2, buttons: [{ index: 0, label: "Ana" }] }]);
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 0, page: 2 });
    expect((await anaApp.next("call.ringing")).from.label).toBe("Mom");
  });
});
