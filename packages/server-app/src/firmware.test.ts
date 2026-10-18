// A phone's firmware changes (docs/security-model.md "Firmware changes"): a kids' phone's
// guardians hear about firmware that isn't an official update, Ask me first holds the phone
// until one allows it, official updates and other phones' changes only go in the audit trail,
// and browser phones are never tracked.
import { HELD_CANT_NOTE, HELD_PHONE_NOTE } from "@openloungephone/core";
import { describe, expect, it } from "vitest";
import { expectStatus, type FakeConn, TestServer } from "./testkit.ts";

const sha = (c: string) => c.repeat(64);
const official = (v: string, c: string) => ({
  sha256: sha(c),
  project: "openloungephone",
  version: v,
  official: true,
});
const homeBuild = { sha256: sha("b"), project: "mia-snake", version: "2", official: false };
const hw = (build?: unknown) => ({ model: "esp32s3", fw: "0.9.8", ...(build ? { build } : {}) });

async function home() {
  const s = new TestServer({ publicUrl: "https://home.test" });
  const jesse = await s.person("jesse", "Jesse");
  const bob = await s.store.createUser(
    { householdId: jesse.household.id, name: "Bob", role: "contact" },
    0,
  );
  const bobToken = await s.store.createSession(bob.id, s.timers.now);
  const kid = await s.pairDevice(jesse.token, "Mia");
  if (!kid.deviceId) throw new Error("pairing failed");
  // Jesse (the guardian who paired it) is on key 1; Bob, a member, on key 2.
  expectStatus(
    await s.http(`/devices/${kid.deviceId}/contacts/${bob.id}`, {
      method: "PUT",
      token: jesse.token,
      body: { label: "Bob", canCallDevice: true, deviceCanCall: true, bypassQuietHours: false },
    }),
    204,
  );
  expectStatus(
    await s.http(`/devices/${kid.deviceId}/buttons/1`, {
      method: "PUT",
      token: jesse.token,
      body: { userId: bob.id },
    }),
    204,
  );
  const jApp = await s.connectApp(jesse.token);
  const bApp = await s.connectApp(bobToken);
  const deviceId = kid.deviceId;
  const connect = async (extra: Record<string, unknown>) => {
    const phone = await s.connectDevice(deviceId, kid.key.pair, undefined, extra);
    return { phone, config: phone.all("config").at(-1) };
  };
  const view = async () =>
    ((await s.http("/devices", { token: jesse.token })).json as Record<string, unknown>[]).find(
      (d) => d.id === deviceId,
    ) as Record<string, unknown>;
  const audit = async () =>
    ((await s.http("/space/audit", { token: jesse.token })).json as { action: string }[]).map(
      (e) => e.action,
    );
  return { s, jesse, bob, bobToken, jApp, bApp, deviceId, connect, view, audit };
}

/** Bob's app calls the phone: how it ended, if it didn't ring. */
async function bobCalls(bApp: FakeConn, phone: FakeConn, deviceId: string) {
  const before = phone.all("call.ringing").length;
  bApp.write({ t: "call.dial", deviceId });
  const state = await bApp.next("call.state");
  return { state, rang: phone.all("call.ringing").length > before };
}

describe("a kids' phone's firmware", () => {
  it("first build: kept quietly; the same image again: nothing", async () => {
    const { jApp, connect, view, audit } = await home();
    const first = await connect(hw(official("0.9.7", "a")));
    expect(first.config?.hold).toBeUndefined();
    expect(await view()).toMatchObject({
      build: { label: "0.9.7", official: true },
      askFirst: true,
      held: false,
    });
    first.phone.close(1000, "bye");
    await connect(hw(official("0.9.7", "a")));
    expect(jApp.all("phone.firmware")).toEqual([]);
    expect((await audit()).filter((a) => a.startsWith("phone.firmware"))).toEqual([]);
  });

  it("an official update: in the audit trail only, no alert, no hold", async () => {
    const { s, jApp, bApp, deviceId, connect, view, audit } = await home();
    (await connect(hw(official("0.9.7", "a")))).phone.close(1000, "bye");
    s.timers.advance(60_000);
    const { phone, config } = await connect(hw(official("0.9.8", "c")));
    expect(config?.hold).toBeUndefined();
    expect(jApp.all("phone.firmware")).toEqual([]);
    expect(await audit()).toContain("phone.firmware.update");
    expect(await view()).toMatchObject({ build: { label: "0.9.8", official: true }, held: false });
    expect((await bobCalls(bApp, phone, deviceId)).rang).toBe(true);
  });

  it("built at home: the guardians are told, and Ask me first holds it until one allows it", async () => {
    const { s, jesse, bobToken, jApp, bApp, deviceId, connect, view, audit } = await home();
    (await connect(hw(official("0.9.7", "a")))).phone.close(1000, "bye");
    s.timers.advance(60_000);
    const { phone, config } = await connect(hw(homeBuild));

    // Told live, in plain facts the app turns into words.
    expect(await jApp.next("phone.firmware")).toMatchObject({
      deviceId,
      name: "Mia",
      project: "mia-snake",
      version: "2",
      held: true,
      at: s.timers.now,
    });
    expect(bApp.all("phone.firmware")).toEqual([]); // members aren't guardians
    expect(await audit()).toContain("phone.firmware.change");
    expect(await view()).toMatchObject({
      build: { label: "mia-snake 2", official: false, since: s.timers.now },
      held: true,
    });

    // Held: ASK A GROWN-UP, only the guardian's key, nobody can call it.
    expect(config).toMatchObject({ hold: true, buttons: [{ index: 0, label: "Jesse" }] });
    const call = await bobCalls(bApp, phone, deviceId);
    expect(call.rang).toBe(false);
    expect(call.state).toMatchObject({ state: "ended", note: HELD_PHONE_NOTE });
    // It calls only its guardians: Bob's key and an extension are refused, Jesse's key rings.
    phone.write({ t: "hook", state: "up" });
    phone.write({ t: "button", index: 1 });
    expect(await phone.nextState("ended")).toMatchObject({ note: HELD_CANT_NOTE });
    phone.write({ t: "call.extension", number: "204" });
    expect(await phone.nextState("ended")).toMatchObject({ note: HELD_CANT_NOTE });
    phone.write({ t: "button", index: 0 });
    const ring = await jApp.next("call.ringing");
    jApp.write({ t: "call.hangup", callId: ring.callId });
    await phone.nextState("ended");
    phone.write({ t: "hook", state: "down" });

    // Only a guardian may allow it.
    expectStatus(
      await s.http(`/devices/${deviceId}/allow`, { method: "POST", token: bobToken }),
      403,
    );
    const configs = phone.all("config").length;
    expectStatus(
      await s.http(`/devices/${deviceId}/allow`, { method: "POST", token: jesse.token }),
      200,
    );
    await expect.poll(() => phone.all("config").length).toBeGreaterThan(configs);
    const after = phone.all("config").at(-1);
    expect(after?.hold).toBeUndefined();
    expect(after?.buttons).toHaveLength(2);
    expect(await audit()).toContain("phone.firmware.allow");
    expect(await view()).toMatchObject({ held: false, build: { label: "mia-snake 2" } });
    expect((await bobCalls(bApp, phone, deviceId)).rang).toBe(true);
    // Allowed stays allowed: reconnecting with the same build doesn't hold it again.
    expectStatus(
      await s.http(`/devices/${deviceId}/allow`, { method: "POST", token: jesse.token }),
      409,
    );
  });

  it("Ask me first off: the guardians are still told, the phone isn't held", async () => {
    const { s, jesse, jApp, bApp, deviceId, connect, view } = await home();
    (await connect(hw(official("0.9.7", "a")))).phone.close(1000, "bye");
    expectStatus(
      await s.http(`/devices/${deviceId}/ask-first`, {
        method: "PUT",
        token: jesse.token,
        body: { on: false },
      }),
      200,
    );
    const { phone, config } = await connect(hw(homeBuild));
    expect(await jApp.next("phone.firmware")).toMatchObject({ held: false });
    expect(config?.hold).toBeUndefined();
    expect(await view()).toMatchObject({ askFirst: false, held: false });
    expect((await bobCalls(bApp, phone, deviceId)).rang).toBe(true);
  });

  it("turning Ask me first off lets a waiting phone go", async () => {
    const { s, jesse, deviceId, connect, view } = await home();
    (await connect(hw(official("0.9.7", "a")))).phone.close(1000, "bye");
    const { phone } = await connect(hw(homeBuild));
    expect(await view()).toMatchObject({ held: true });
    const configs = phone.all("config").length;
    expectStatus(
      await s.http(`/devices/${deviceId}/ask-first`, {
        method: "PUT",
        token: jesse.token,
        body: { on: false },
      }),
      200,
    );
    await expect.poll(() => phone.all("config").length).toBeGreaterThan(configs);
    expect(phone.all("config").at(-1)?.hold).toBeUndefined();
    expect(await view()).toMatchObject({ held: false });
  });

  it("a hardware phone that stops reporting its build counts as a change", async () => {
    const { jApp, connect } = await home();
    (await connect(hw(official("0.9.7", "a")))).phone.close(1000, "bye");
    const { config } = await connect(hw());
    expect(await jApp.next("phone.firmware")).toMatchObject({ version: "unknown" });
    expect(config?.hold).toBe(true);
  });
});

describe("other phones", () => {
  it("browser phones are never tracked, whatever they send", async () => {
    const { jApp, connect, view, audit } = await home();
    (await connect({ build: official("0.9.7", "a") })).phone.close(1000, "bye");
    const { config } = await connect({ build: homeBuild });
    expect(config?.hold).toBeUndefined();
    expect(jApp.all("phone.firmware")).toEqual([]);
    expect((await view()).build).toBeNull();
    expect((await audit()).filter((a) => a.startsWith("phone.firmware"))).toEqual([]);
  });

  it("a person's own phone: an audit entry only", async () => {
    const s = new TestServer({ publicUrl: "https://home.test" });
    const jesse = await s.person("jesse", "Jesse");
    const jApp = await s.connectApp(jesse.token);
    const mine = await s.pairDevice(jesse.token, "Desk", { forMe: true });
    if (!mine.deviceId) throw new Error("pairing failed");
    const id = mine.deviceId;
    (await s.connectDevice(id, mine.key.pair, undefined, hw(official("0.9.7", "a")))).close(
      1000,
      "bye",
    );
    const phone = await s.connectDevice(id, mine.key.pair, undefined, hw(homeBuild));
    expect(phone.all("config").at(-1)?.hold).toBeUndefined();
    expect(jApp.all("phone.firmware")).toEqual([]);
    const audit = (await s.http("/space/audit", { token: jesse.token })).json as {
      action: string;
    }[];
    expect(audit.map((e) => e.action)).toContain("phone.firmware.change");
    const list = (await s.http("/devices", { token: jesse.token })).json as Record<
      string,
      unknown
    >[];
    expect(list.find((d) => d.id === id)).not.toHaveProperty("askFirst");
    expectStatus(
      await s.http(`/devices/${id}/ask-first`, {
        method: "PUT",
        token: jesse.token,
        body: { on: true },
      }),
      404,
    );
  });
});
