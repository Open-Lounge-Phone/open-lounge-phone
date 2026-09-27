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

describe("invites", () => {
  it("creates a new person once, then is used up", async () => {
    const { household: hh, guardian } = await household();
    const { token } = await store.createInvite(
      { householdId: hh.id, name: "Grandma", role: "contact", createdBy: guardian.id },
      T0,
    );
    expect(await store.peekInvite(token, T0)).toMatchObject({ name: "Grandma", userId: null });
    const grandma = await store.acceptInvite(token, T0 + 1);
    expect(grandma).toMatchObject({ name: "Grandma", role: "contact", householdId: hh.id });
    expect(await store.acceptInvite(token, T0 + 2)).toBeUndefined();
    expect((await store.listUsers(hh.id)).map((u) => u.name)).toEqual(["Mom", "Grandma"]);
  });

  it("signs an existing person in without creating anyone", async () => {
    const { household: hh, guardian } = await household();
    const { token } = await store.createInvite(
      {
        householdId: hh.id,
        userId: guardian.id,
        name: "Mom",
        role: "guardian",
        createdBy: guardian.id,
      },
      T0,
    );
    expect((await store.acceptInvite(token, T0))?.id).toBe(guardian.id);
    expect(await store.listUsers(hh.id)).toHaveLength(1);
  });

  it("expires", async () => {
    const { household: hh, guardian } = await household();
    const { token, expiresAt } = await store.createInvite(
      { householdId: hh.id, name: "X", role: "contact", createdBy: guardian.id },
      T0,
    );
    expect(await store.acceptInvite(token, expiresAt)).toBeUndefined();
  });
});

describe("passkey challenges", () => {
  it("are single use and kind-specific", async () => {
    const { guardian } = await household();
    const id = await store.saveChallenge(
      { kind: "register", challenge: "abc", userId: guardian.id },
      T0,
    );
    expect(await store.takeChallenge(id, "login", T0)).toBeUndefined();
    const again = await store.saveChallenge({ kind: "login", challenge: "xyz" }, T0);
    expect(await store.takeChallenge(again, "login", T0)).toEqual({
      challenge: "xyz",
      userId: null,
    });
    expect(await store.takeChallenge(again, "login", T0)).toBeUndefined();
  });

  it("round-trip passkeys and scope deletion to the owner", async () => {
    const { guardian } = await household();
    await store.addPasskey({
      id: "cred1",
      userId: guardian.id,
      publicKey: "pk",
      counter: 0,
      transports: ["internal"],
      name: "Laptop",
      createdAt: T0,
    });
    await store.touchPasskey("cred1", 5, T0 + 1);
    expect(await store.getPasskey("cred1")).toMatchObject({ counter: 5, lastUsedAt: T0 + 1 });
    expect(await store.deletePasskey("cred1", "usr_other")).toBe(false);
    expect(await store.deletePasskey("cred1", guardian.id)).toBe(true);
  });
});

describe("voicemail", () => {
  it("tracks unheard callers per device, newest first", async () => {
    const { household: hh, guardian } = await household();
    const { code } = await store.createPairing(KEY, T0);
    const device = await store.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    if (!device) throw new Error("no device");
    const base = {
      householdId: hh.id,
      deviceId: device.id,
      fromUser: guardian.id,
      durationMs: 1000,
      mime: "audio/webm",
      blobKey: "k",
      transcriptStatus: "pending" as const,
    };
    const a = await store.createVoicemail({ ...base, fromLabel: "Mom", createdAt: T0 });
    await store.createVoicemail({ ...base, fromLabel: "Grandma", createdAt: T0 + 5 });
    await store.createVoicemail({ ...base, fromLabel: "Mom", createdAt: T0 + 10 });
    expect(await store.unheardFrom(device.id)).toEqual(["Mom", "Grandma"]);
    await store.setTranscript(a.id, "done", "hello");
    await store.markVoicemailHeard(a.id, T0 + 20);
    expect(await store.getVoicemail(a.id)).toMatchObject({
      transcript: "hello",
      transcriptStatus: "done",
      heardAt: T0 + 20,
    });
    expect(await store.unheardFrom(device.id)).toEqual(["Mom", "Grandma"]); // newer Mom unheard
    expect((await store.listVoicemails(hh.id)).map((v) => v.createdAt)).toEqual([
      T0 + 10,
      T0 + 5,
      T0,
    ]);
  });

  it("remembers each device's key algorithm", async () => {
    const { household: hh } = await household();
    const { code } = await store.createPairing("P".repeat(87), T0, "p256");
    const device = await store.claimPairing({ code, householdId: hh.id, name: "HW" }, T0);
    expect(device?.keyAlg).toBe("p256");
    expect((await store.getDevice(device?.id ?? ""))?.keyAlg).toBe("p256");
  });
});

describe("single use under concurrency", () => {
  it("accepts an invite only once even when raced", async () => {
    const { household: hh, guardian } = await household();
    const { token } = await store.createInvite(
      { householdId: hh.id, name: "Grandma", role: "contact", createdBy: guardian.id },
      T0,
    );
    const results = await Promise.all([
      store.acceptInvite(token, T0),
      store.acceptInvite(token, T0),
      store.acceptInvite(token, T0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listUsers(hh.id)).toHaveLength(2);
  });

  it("hands out a challenge only once even when raced", async () => {
    await household();
    const id = await store.saveChallenge({ kind: "login", challenge: "c" }, T0);
    const results = await Promise.all([
      store.takeChallenge(id, "login", T0),
      store.takeChallenge(id, "login", T0),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
