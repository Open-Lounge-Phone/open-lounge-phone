import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { newPairingCode } from "./crypto.ts";
import { MIGRATIONS_DIR, migrate, openSqlite } from "./node.ts";
import { handleFromName, handleProblem, PAIRING_TTL_MS, SESSION_TTL_MS, Store } from "./store.ts";

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
      { kind: "register", challenge: "abc", accountId: guardian.accountId },
      T0,
    );
    expect(await store.takeChallenge(id, "login", T0)).toBeUndefined();
    const again = await store.saveChallenge({ kind: "login", challenge: "xyz" }, T0);
    expect(await store.takeChallenge(again, "login", T0)).toEqual({
      challenge: "xyz",
      accountId: null,
      data: null,
    });
    expect(await store.takeChallenge(again, "login", T0)).toBeUndefined();
  });

  it("round-trip passkeys and scope deletion to the owner", async () => {
    const { guardian } = await household();
    await store.addPasskey({
      id: "cred1",
      accountId: guardian.accountId,
      publicKey: "pk",
      counter: 0,
      transports: ["internal"],
      name: "Laptop",
      createdAt: T0,
    });
    await store.touchPasskey("cred1", 5, T0 + 1);
    expect(await store.getPasskey("cred1")).toMatchObject({ counter: 5, lastUsedAt: T0 + 1 });
    expect(await store.deletePasskey("cred1", "acc_other")).toBe(false);
    expect(await store.deletePasskey("cred1", guardian.accountId)).toBe(true);
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
      toUser: null,
      fromUser: guardian.id,
      fromAddress: null,
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

  it("keeps a person's voicemail in their own inbox, not a phone's", async () => {
    const { household: hh, guardian } = await household();
    const vm = await store.createVoicemail({
      householdId: hh.id,
      deviceId: null,
      toUser: guardian.id,
      fromUser: null,
      fromLabel: "Bob",
      fromAddress: "bob@b.test",
      createdAt: T0,
      durationMs: 1000,
      mime: "audio/webm",
      blobKey: "k",
      transcriptStatus: "pending",
    });
    expect(await store.listPersonalVoicemails(guardian.accountId)).toMatchObject([
      { id: vm.id, toUser: guardian.id, deviceId: null, fromAddress: "bob@b.test" },
    ]);
    const other = await household();
    expect(await store.listPersonalVoicemails(other.guardian.accountId)).toEqual([]);
    // Exactly one of phone or person.
    await expect(
      store.createVoicemail({ ...vm, deviceId: null, toUser: null, heardAt: undefined } as never),
    ).rejects.toThrow();
  });

  it("stores voicemail settings and greetings per person and per phone", async () => {
    const { guardian } = await household();
    const owner = { accountId: guardian.accountId };
    expect(await store.voicemailPrefs(owner)).toEqual({
      ringSeconds: 25,
      childGreeting: true,
      greeting: null,
    });
    await store.setVoicemailPrefs(owner, { ringSeconds: 40 }, T0);
    const g = { kind: "name" as const, mime: "audio/webm", blobKey: "g1", durationMs: 2000 };
    expect(await store.setGreeting(owner, g, T0)).toBeUndefined();
    expect(await store.setGreeting(owner, { ...g, blobKey: "g2" }, T0)).toBe("g1");
    expect(await store.voicemailPrefs(owner)).toMatchObject({
      ringSeconds: 40,
      greeting: { kind: "name", blobKey: "g2" },
    });
    await store.setVoicemailPrefs(owner, { childGreeting: false }, T0);
    expect(await store.setGreeting(owner, null, T0)).toBe("g2");
    expect(await store.voicemailPrefs(owner)).toEqual({
      ringSeconds: 40,
      childGreeting: false,
      greeting: null,
    });
  });

  it("uses a voicemail ticket once, even under a race", async () => {
    const token = await store.createVoicemailTicket("voicemail", { to: "x" }, T0);
    expect(await store.peekVoicemailTicket(token, "greeting", T0)).toBeUndefined();
    expect(await store.peekVoicemailTicket(token, "voicemail", T0)).toEqual({ to: "x" });
    const takes = await Promise.all([
      store.takeVoicemailTicket(token, "voicemail", T0),
      store.takeVoicemailTicket(token, "voicemail", T0),
    ]);
    expect(takes.filter((t) => t !== undefined)).toHaveLength(1);
    const late = await store.createVoicemailTicket("voicemail", {}, T0, 1000);
    expect(await store.takeVoicemailTicket(late, "voicemail", T0 + 1000)).toBeUndefined();
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

describe("0006_accounts backfill", () => {
  it("gives every existing person an account with a unique handle, keeping sessions and passkeys", async () => {
    // A database as it was before accounts: migrations up to 0005 only.
    const dir = mkdtempSync(join(tmpdir(), "olp-mig-"));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < "0006")) {
      copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    }
    const old = openSqlite(":memory:");
    migrate(old.db, dir);
    rmSync(dir, { recursive: true, force: true });
    old.db.exec(`
      INSERT INTO households (id, name, time_zone, created_at) VALUES ('hh_1', 'Home', 'UTC', 1);
      INSERT INTO users (id, household_id, name, role, created_at) VALUES
        ('usr_AAAAAAAAAAAAAAAA', 'hh_1', 'Mom', 'guardian', 1),
        ('usr_BBBBBBBBBBBBBBBB', 'hh_1', 'mom', 'contact', 2),
        ('usr_CCCCCCCCCCCCCCCC', 'hh_1', 'Grandma Jo', 'contact', 3),
        ('usr_DDDDDDDDDDDDDDDD', 'hh_1', 'José', 'contact', 4),
        ('usr_EEEEEEEEEEEEEEEE', 'hh_1', 'Zoë', 'contact', 5),
        ('usr_FFFFFFFFFFFFFFFF', 'hh_1', 'M', 'contact', 6),
        ('usr_GGGGGGGGGGGGGGGG', 'hh_1', 'MOM', 'contact', 7);
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
        VALUES ('h1', 'usr_AAAAAAAAAAAAAAAA', 1, 9999999999999);
      INSERT INTO passkeys (id, user_id, public_key, name, created_at)
        VALUES ('cred1', 'usr_CCCCCCCCCCCCCCCC', 'pk', 'Laptop', 1);
    `);
    expect(migrate(old.db)).toContain("0006_accounts.sql");
    const rows = old.db
      .prepare(
        "SELECT u.name, a.handle, a.name AS account_name FROM users u JOIN accounts a ON a.id = u.account_id ORDER BY u.created_at",
      )
      .all() as { name: string; handle: string; account_name: string }[];
    expect(rows.map((r) => [r.name, r.handle])).toEqual([
      ["Mom", "mom"],
      ["mom", "mom-2"],
      ["Grandma Jo", "grandma.jo"],
      ["José", "user"],
      ["Zoë", "user-2"],
      ["M", "user-3"],
      ["MOM", "mom-3"],
    ]);
    for (const r of rows) {
      expect(r.account_name).toBe(r.name);
      expect(handleProblem(r.handle)).toBeUndefined();
    }
    const s = new Store(old.sql);
    const user = await s.getUser("usr_AAAAAAAAAAAAAAAA");
    expect(old.db.prepare("SELECT account_id, user_id FROM sessions").get()).toEqual({
      account_id: user?.accountId,
      user_id: "usr_AAAAAAAAAAAAAAAA",
    });
    const grandma = await s.getUser("usr_CCCCCCCCCCCCCCCC");
    expect((await s.getPasskey("cred1"))?.accountId).toBe(grandma?.accountId);
    old.db.close();
  });
});

describe("0012_voicemail_everywhere", () => {
  it("keeps existing voicemail and its call-log link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "olp-mig-"));
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < "0012")) {
      copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    }
    const old = openSqlite(":memory:");
    migrate(old.db, dir);
    rmSync(dir, { recursive: true, force: true });
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const device = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    old.db.exec(`
      INSERT INTO voicemails (id, household_id, device_id, from_user, from_label, created_at,
        duration_ms, mime, blob_key, transcript_status)
        VALUES ('vm_1', '${hh.id}', '${device?.id}', '${guardian.id}', 'Mom', 1, 1000, 'audio/webm', 'k', 'done');
      INSERT INTO call_log (id, household_id, device_id, peer, peer_label, direction, started_at,
        voicemail_id) VALUES ('cl_1', '${hh.id}', '${device?.id}', 'user:x', 'Mom', 'in', 1, 'vm_1');
    `);
    expect(migrate(old.db)).toContain("0012_voicemail_everywhere.sql");
    expect(await s.getVoicemail("vm_1")).toMatchObject({
      deviceId: device?.id,
      toUser: null,
      fromLabel: "Mom",
      transcriptStatus: "done",
    });
    expect(old.db.prepare("SELECT voicemail_id FROM call_log WHERE id = 'cl_1'").get()).toEqual({
      voicemail_id: "vm_1",
    });
    old.db.close();
  });
});

/** A database migrated up to (not including) migration `before`. */
function openBefore(before: string) {
  const dir = mkdtempSync(join(tmpdir(), "olp-mig-"));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < before)) {
    copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
  }
  const old = openSqlite(":memory:");
  migrate(old.db, dir);
  rmSync(dir, { recursive: true, force: true });
  return old;
}

describe("0013 and later (timeline, device modes, security)", () => {
  it("keep existing spaces, phones, connections, calls and voicemail as they were", async () => {
    const old = openBefore("0013");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const device = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    const other = await s.createAccount({ name: "Bob", handle: "bob" }, T0);
    old.db.exec(`
      INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
        state, direction, created_at, updated_at) VALUES ('con_1', '${guardian.accountId}', '',
        'bob', '${other?.id}', 'Bob', 'active', 'none', 1, 1);
      INSERT INTO voicemails (id, household_id, to_user, from_label, from_address, created_at,
        duration_ms, mime, blob_key, transcript_status)
        VALUES ('vm_1', '${hh.id}', '${guardian.id}', 'Bob', 'bob@x', 1, 1000, 'audio/webm', 'k',
          'done');
      INSERT INTO call_log (id, household_id, account_id, peer, peer_label, direction, started_at,
        voicemail_id) VALUES ('cl_1', '${hh.id}', '${guardian.accountId}', 'bob@x', 'Bob', 'in', 1,
          'vm_1');
      UPDATE households SET lounge_idle_minutes = 15, lounge_guests = 1;
    `);
    expect(migrate(old.db)).toContain("0013_buddy_timeline.sql");
    expect(await s.getVoicemail("vm_1")).toMatchObject({ toUser: guardian.id, fromLabel: "Bob" });
    expect(await s.callLog(guardian.accountId)).toMatchObject([
      { id: "cl_1", peer: "bob@x", voicemailId: "vm_1" },
    ]);
    // New settings start unset: nothing expires until someone chooses to.
    expect(await s.connections.get("con_1")).toMatchObject({
      state: "active",
      retentionDays: null,
    });
    expect((await s.getAccount(guardian.accountId))?.retentionDays).toBeNull();
    expect(await s.getDevice(device?.id as string)).toMatchObject({ name: "Kid", kind: "kids" });
    const swept = await s.sweepExpired(hh.id, "x", T0 * 2);
    expect(swept).toEqual({ calls: 0, voicemails: 0, blobs: [] });
    // Lounge settings keep their values; the new ones start as before (idle timeout, all off).
    expect(await s.loungeSettings(hh.id)).toEqual({
      idleMinutes: 15,
      guests: true,
      session: "idle",
      dayEnd: "00:00",
      idle: { houseLine: { enabled: false, keys: [] }, whosHere: false },
    });
    expect(await s.removedDevice("dev_x")).toBeUndefined();
    // 0015: privacy defaults keep everything and keep transcribing; phones haven't reported yet.
    expect(await s.spacePrivacy(hh.id)).toEqual({
      historyDays: null,
      voicemailDays: null,
      transcribe: true,
    });
    expect(await s.getDevice(device?.id as string)).toMatchObject({ fw: null, model: null });
    old.db.close();
  });
});

describe("accounts and handles", () => {
  it("validates handles", () => {
    for (const ok of ["jo", "jesse", "jesse.garcia", "a_b-c", "x".repeat(30)]) {
      expect(handleProblem(ok)).toBeUndefined();
    }
    for (const bad of ["j", "Jesse", "jes se", "jö", "x".repeat(31), "a@b", "", "admin"]) {
      expect(handleProblem(bad)).toBeDefined();
    }
    expect(handleFromName("José Díaz")).toBe("jose.diaz");
    expect(handleFromName("  Grandma  ")).toBe("grandma");
    expect(handleFromName("🙂")).toBe("user");
    expect(handleFromName("Admin")).toBe("user");
  });

  it("keeps handles unique, derives unique ones from names, and changes them", async () => {
    const a = await store.createAccount({ name: "Jesse", handle: "jesse" }, T0);
    expect(a?.handle).toBe("jesse");
    expect(await store.createAccount({ name: "Other", handle: "jesse" }, T0)).toBeUndefined();
    expect((await store.createAccount({ name: "Jesse" }, T0))?.handle).toBe("jesse-2");
    const b = await store.createAccount({ name: "Bo", handle: "bo" }, T0);
    expect(await store.setHandle(b?.id ?? "", "jesse", T0)).toBe(false);
    expect(await store.setHandle(b?.id ?? "", "bobby", T0 + 1)).toBe(true);
    expect(await store.accountByHandle("BOBBY")).toMatchObject({
      id: b?.id,
      handleChangedAt: T0 + 1,
    });
    expect(await store.accountByHandle("bo")).toBeUndefined();
  });

  it("lets one account belong to two households and switch between them", async () => {
    const { household: home, guardian } = await household();
    const { household: gran } = await store.createHousehold(
      { name: "Gran's", timeZone: "UTC", guardianName: "Mom", accountId: guardian.accountId },
      T0,
    );
    const memberships = await store.listMemberships(guardian.accountId);
    expect(memberships.map((m) => m.household.name)).toEqual(["Home", "Gran's"]);
    const token = await store.createSession(guardian.id, T0);
    expect((await store.userForToken(token, T0))?.householdId).toBe(home.id);
    const granMember = await store.membership(guardian.accountId, gran.id);
    await store.setSessionUser(token, granMember?.id ?? "");
    expect((await store.userForToken(token, T0))?.householdId).toBe(gran.id);
    // Another account's membership can't be made active.
    const stranger = await store.createHousehold(
      { name: "Else", timeZone: "UTC", guardianName: "Eve" },
      T0,
    );
    await store.setSessionUser(token, stranger.guardian.id);
    expect((await store.userForToken(token, T0))?.householdId).toBe(gran.id);
  });

  it("falls back to another household when removed, and ends the account with the last one", async () => {
    const { household: home, guardian } = await household();
    const kid = await store.createUser({ householdId: home.id, name: "Kid", role: "contact" }, T0);
    const { household: other, guardian: eve } = await store.createHousehold(
      { name: "Other", timeZone: "UTC", guardianName: "Eve" },
      T0,
    );
    const kidThere = await store.createUser(
      { householdId: other.id, name: "Kid", role: "contact", accountId: kid.accountId },
      T0,
    );
    const token = await store.createSession(kidThere.id, T0);
    await store.deleteUser(kidThere.id, 0);
    expect((await store.userForToken(token, T0))?.householdId).toBe(home.id);
    await store.deleteUser(kid.id, 0);
    expect(await store.sessionForToken(token, T0)).toBeUndefined();
    expect(await store.getAccount(kid.accountId)).toBeUndefined();
    expect(await store.getAccount(guardian.accountId)).toBeDefined();
    expect(await store.getAccount(eve.accountId)).toBeDefined();
  });
});
