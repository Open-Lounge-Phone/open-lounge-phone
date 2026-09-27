import { beforeEach, describe, expect, it } from "vitest";
import { newPairingCode } from "./crypto.ts";
import { migrate, openSqlite } from "./node.ts";
import { PAIRING_TTL_MS, SESSION_TTL_MS, Store } from "./store.ts";

const T0 = 1_780_000_000_000;
const KEY = "k".repeat(43);

let store: Store;
let db: ReturnType<typeof openSqlite>["db"];

beforeEach(() => {
  const opened = openSqlite(":memory:");
  db = opened.db;
  migrate(db);
  store = new Store(opened.sql);
});

async function household() {
  return store.createHousehold({ name: "Home", timeZone: "UTC", guardianName: "Mom" }, T0);
}

describe("migrate", () => {
  it("is idempotent", () => {
    expect(migrate(db)).toEqual([]);
  });
});

describe("sessions", () => {
  it("resolves tokens until they expire, and stores only hashes", async () => {
    const { guardian } = await household();
    const token = await store.createSession(guardian.id, T0);
    expect((await store.userForToken(token, T0 + 1))?.id).toBe(guardian.id);
    expect(await store.userForToken(token, T0 + SESSION_TTL_MS)).toBeUndefined();
    expect(await store.userForToken("wrong", T0)).toBeUndefined();
    const raw = JSON.stringify(db.prepare("SELECT * FROM sessions").all());
    expect(raw).not.toContain(token);
  });

  it("can be revoked", async () => {
    const { guardian } = await household();
    const token = await store.createSession(guardian.id, T0);
    await store.deleteSession(token);
    expect(await store.userForToken(token, T0)).toBeUndefined();
  });
});

describe("pairing", () => {
  it("claims a code once and creates the device", async () => {
    const { household: hh } = await household();
    const { code, expiresAt } = await store.createPairing(KEY, T0);
    expect(code).toMatch(/^\d{6}$/);
    expect(expiresAt).toBe(T0 + PAIRING_TTL_MS);
    const device = await store.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0 + 1);
    expect(device).toMatchObject({ householdId: hh.id, publicKey: KEY, name: "Kid" });
    expect(await store.claimPairing({ code, householdId: hh.id, name: "Again" }, T0 + 2)).toBe(
      undefined,
    );
    expect(await store.listDevices(hh.id)).toHaveLength(1);
  });

  it("rejects expired codes", async () => {
    const { household: hh } = await household();
    const { code } = await store.createPairing(KEY, T0);
    expect(
      await store.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0 + PAIRING_TTL_MS),
    ).toBeUndefined();
  });

  it("replaces an earlier code for the same key", async () => {
    const { household: hh } = await household();
    const first = await store.createPairing(KEY, T0);
    const second = await store.createPairing(KEY, T0 + 1);
    const claimFirst = await store.claimPairing(
      { code: first.code, householdId: hh.id, name: "Kid" },
      T0 + 2,
    );
    // The first code only survives if the random second code happened to equal it.
    if (first.code !== second.code) expect(claimFirst).toBeUndefined();
  });

  it("re-pairing a key replaces the old device", async () => {
    const { household: hh } = await household();
    const a = await store.createPairing(KEY, T0);
    const d1 = await store.claimPairing({ code: a.code, householdId: hh.id, name: "A" }, T0);
    const b = await store.createPairing(KEY, T0);
    const d2 = await store.claimPairing({ code: b.code, householdId: hh.id, name: "B" }, T0);
    expect(d2?.id).not.toBe(d1?.id);
    expect((await store.listDevices(hh.id)).map((d) => d.name)).toEqual(["B"]);
  });
});

describe("allow-list, buttons and quiet hours", () => {
  it("round-trips contacts and buttons, and removing a contact unmaps its buttons", async () => {
    const { household: hh, guardian } = await household();
    const { code } = await store.createPairing(KEY, T0);
    const device = await store.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    if (!device) throw new Error("no device");
    const contact = {
      id: guardian.id,
      label: "Mom",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: true,
    };
    await store.upsertContact(device.id, contact);
    await store.upsertContact(device.id, { ...contact, label: "Mama" });
    expect(await store.listContacts(device.id)).toEqual([{ ...contact, label: "Mama" }]);
    await store.setButton(device.id, 2, guardian.id);
    expect(await store.listButtons(device.id)).toEqual(new Map([[2, guardian.id]]));
    await store.removeContact(device.id, guardian.id);
    expect(await store.getContact(device.id, guardian.id)).toBeUndefined();
    expect((await store.listButtons(device.id)).size).toBe(0);
  });

  it("replaces quiet rules and builds the schedule", async () => {
    const { household: hh } = await household();
    await store.setQuietRules(hh.id, [{ days: [1, 2], start: "21:00", end: "07:00" }]);
    await store.setQuietRules(hh.id, [{ days: [0], start: "08:00", end: "09:00" }]);
    expect(await store.getSchedule(hh.id)).toEqual({
      timeZone: "UTC",
      rules: [{ days: [0], start: "08:00", end: "09:00" }],
    });
  });

  it("rolls back a failing batch", async () => {
    const sql = openSqlite(":memory:");
    migrate(sql.db);
    await expect(
      sql.sql.batch([
        { query: "INSERT INTO settings (key, value) VALUES ('a', '1')", params: [] },
        { query: "INSERT INTO settings (key, value) VALUES ('a', '2')", params: [] },
      ]),
    ).rejects.toThrow();
    expect(await sql.sql.all("SELECT * FROM settings")).toEqual([]);
  });
});

describe("newPairingCode", () => {
  it("always yields six digits", () => {
    for (let i = 0; i < 500; i++) expect(newPairingCode()).toMatch(/^\d{6}$/);
  });
});
