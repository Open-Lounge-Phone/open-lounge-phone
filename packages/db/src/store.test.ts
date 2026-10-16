import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { newPairingCode, sha256 } from "./crypto.ts";
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

  it("shows a personal phone its owner's voicemail from every space", async () => {
    const { household: home, guardian } = await household();
    const { household: other, guardian: meThere } = await store.createHousehold(
      { name: "Other", timeZone: "UTC", guardianName: "Mom", accountId: guardian.accountId },
      T0,
    );
    const { code } = await store.createPairing(KEY, T0);
    const phone = await store.claimPairing({ code, householdId: home.id, name: "Mine" }, T0);
    if (!phone) throw new Error("no device");
    await store.createVoicemail({
      householdId: other.id,
      deviceId: null,
      toUser: meThere.id,
      fromUser: null,
      fromLabel: "Test phone",
      fromAddress: null,
      createdAt: T0,
      durationMs: 1000,
      mime: "audio/wav",
      blobKey: "k",
      transcriptStatus: "pending",
    });
    expect(await store.unheardFrom(phone.id, 8, guardian.id)).toEqual(["Test phone"]);
    const stranger = await household();
    expect(await store.unheardFrom(phone.id, 8, stranger.guardian.id)).toEqual([]);
    expect(await store.unheardFrom(phone.id, 8, null)).toEqual([]);
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

  it("uses a recording ticket once, even under a race, and not after it expires", async () => {
    const data = {
      householdId: "hh",
      kind: "call" as const,
      callId: "c1",
      accountId: null,
      peer: "user:x",
      peerLabel: "X",
      startedAt: T0,
    };
    const token = await store.recordings.createTicket(data, T0);
    expect(await store.recordings.peekTicket(token, T0)).toEqual(data);
    const takes = await Promise.all([
      store.recordings.takeTicket(token, T0),
      store.recordings.takeTicket(token, T0),
    ]);
    expect(takes.filter((t) => t !== undefined)).toHaveLength(1);
    const late = await store.recordings.createTicket(data, T0);
    expect(await store.recordings.takeTicket(late, T0 + 6 * 60 * 60 * 1000)).toBeUndefined();
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
    expect(swept).toEqual({ calls: 0, voicemails: 0, recordings: 0, blobs: [] });
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

describe("0017_workplace", () => {
  it("keeps phones', people's voicemail and call-log links; adds shared boxes", async () => {
    const old = openBefore("0017");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const device = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    old.db.exec(`
      INSERT INTO voicemails (id, household_id, device_id, from_user, from_label, from_address,
        created_at, duration_ms, mime, blob_key, transcript, transcript_status, heard_at)
        VALUES ('vm_1', '${hh.id}', '${device?.id}', '${guardian.id}', 'Mom', 'user:x', 1, 1000,
          'audio/webm', 'k1', 'hi', 'done', 5);
      INSERT INTO voicemails (id, household_id, to_user, from_label, created_at, duration_ms, mime,
        blob_key, transcript_status) VALUES ('vm_2', '${hh.id}', '${guardian.id}', 'Bob', 2, 2000,
          'audio/ogg', 'k2', 'pending');
      INSERT INTO call_log (id, household_id, device_id, peer, peer_label, direction, started_at,
        voicemail_id) VALUES ('cl_1', '${hh.id}', '${device?.id}', 'user:x', 'Mom', 'in', 1, 'vm_1');
    `);
    expect(migrate(old.db)).toContain("0017_workplace.sql");
    expect(await s.getVoicemail("vm_1")).toMatchObject({
      deviceId: device?.id,
      toUser: null,
      groupId: null,
      transcript: "hi",
      heardAt: 5,
      heardBy: null,
    });
    expect(await s.getVoicemail("vm_2")).toMatchObject({ toUser: guardian.id, fromLabel: "Bob" });
    expect(old.db.prepare("SELECT voicemail_id FROM call_log WHERE id = 'cl_1'").get()).toEqual({
      voicemail_id: "vm_1",
    });
    // Still exactly one owner per message, now also a ring group's box.
    const group = await s.workplace.createGroup(
      { householdId: hh.id, name: "Desk", strategy: "simultaneous", ringSeconds: 20, members: [] },
      T0,
    );
    const shared = await s.createVoicemail({
      householdId: hh.id,
      deviceId: null,
      toUser: null,
      groupId: group.id,
      fromUser: null,
      fromLabel: "Caller",
      fromAddress: null,
      createdAt: T0,
      durationMs: 1,
      mime: "audio/webm",
      blobKey: "k3",
      transcriptStatus: "unavailable",
    });
    await s.markVoicemailHeard(shared.id, T0 + 1, guardian.id);
    await s.markVoicemailHeard(shared.id, T0 + 2, "someone-else");
    expect(await s.getVoicemail(shared.id)).toMatchObject({
      heardAt: T0 + 1,
      heardBy: guardian.id,
    });
    expect(() =>
      old.db.exec(`INSERT INTO voicemails (id, household_id, device_id, group_id, from_label,
        created_at, duration_ms, mime, blob_key) VALUES ('vm_x', '${hh.id}', '${device?.id}',
        '${group.id}', 'x', 1, 1, 'audio/webm', 'k')`),
    ).toThrow();
    expect(await s.listGroupVoicemails([group.id])).toHaveLength(1);
    expect(await s.voicemailBlobs({ groupId: group.id })).toEqual(["k3"]);
    // Deleting the group takes its box (and its extension) with it.
    await s.workplace.setExtension(
      { householdId: hh.id, number: "100", kind: "group", targetId: group.id },
      T0,
    );
    await s.workplace.deleteGroup(group.id);
    expect(await s.getVoicemail(shared.id)).toBeUndefined();
    expect(await s.workplace.extensions(hh.id)).toEqual([]);
    old.db.close();
  });
});

describe("0018_recording", () => {
  it("keeps call logs and spaces; recording starts off; recordings link to their call", async () => {
    const old = openBefore("0018");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Office", timeZone: "UTC", guardianName: "Olga", type: "team" },
      T0,
    );
    old.db.exec(`
      INSERT INTO call_log (id, household_id, account_id, peer, peer_label, direction, started_at,
        answered, duration_ms) VALUES ('cl_1', '${hh.id}', '${guardian.accountId}', 'user:x', 'X',
        'out', 1, 1, 60000);
    `);
    expect(migrate(old.db)).toContain("0018_recording.sql");
    expect(await s.recordings.enabled(hh.id)).toBe(false);
    expect(await s.callLogEntry("cl_1")).toMatchObject({
      durationMs: 60000,
      callId: null,
      recordingId: null,
    });
    await s.logCall({
      householdId: hh.id,
      accountId: guardian.accountId,
      deviceId: null,
      peer: "user:y",
      peerLabel: "Y",
      direction: "in",
      startedAt: T0,
      answered: true,
      durationMs: 1000,
      endReason: "hangup",
      callId: "call_1",
    });
    const rec = await s.recordings.create({
      householdId: hh.id,
      kind: "call",
      callId: "call_1",
      accountId: guardian.accountId,
      peer: "user:y",
      peerLabel: "Y",
      startedAt: T0,
      createdAt: T0,
      durationMs: 1000,
      mime: "audio/webm",
      blobKey: "k",
      bytes: 1,
      transcriptStatus: "unavailable",
    });
    const [row] = await s.callLog(guardian.accountId, "user:y");
    expect(row?.recordingId).toBe(rec.id);
    expect(await s.recordings.wasParty(rec.id, guardian.accountId)).toBe(true);
    expect(await s.voicemailBlobs({ householdId: hh.id })).toContain("k");
    old.db.close();
  });
});

describe("0019_key_rotation", () => {
  it("keeps pinned keys and refused changes; re-pins only over the key it expects", async () => {
    const old = openBefore("0019");
    const s = new Store(old.sql);
    old.db.exec(`
      INSERT INTO server_keys (host, public_key, first_seen, last_seen, rejected_key, rejected_at)
      VALUES ('a.example', 'K1', 10, 20, 'K2', 30), ('b.example', 'B1', 5, 6, NULL, NULL);
    `);
    expect(migrate(old.db)).toContain("0019_key_rotation.sql");
    expect(await s.connections.pinnedKeys()).toEqual([
      {
        host: "a.example",
        publicKey: "K1",
        firstSeen: 10,
        lastSeen: 20,
        keySince: 10,
        rejected: { publicKey: "K2", at: 30 },
      },
      {
        host: "b.example",
        publicKey: "B1",
        firstSeen: 5,
        lastSeen: 6,
        keySince: 5,
        rejected: null,
      },
    ]);
    expect(await s.connections.repinKey("a.example", "K0", "K2", 40)).toBe(false);
    expect(await s.connections.repinKey("a.example", "K1", "K2", 40)).toBe(true);
    expect(await s.connections.pinnedKeyRow("a.example")).toMatchObject({
      publicKey: "K2",
      firstSeen: 10,
      keySince: 40,
      rejected: null,
    });
    // A refused key is reported once, however often it is presented.
    expect(await s.connections.rejectKey("b.example", "B2", 50)).toBe(true);
    expect(await s.connections.rejectKey("b.example", "B2", 51)).toBe(false);
    expect(await s.connections.ownKey()).toBeUndefined();
    await s.operatorAudit({ at: 1, actorAccount: null, actorName: "x", action: "a", detail: null });
    expect(await s.operatorAuditLog()).toMatchObject([{ action: "a", detail: null }]);
    old.db.close();
  });
});

describe("0020_server_info", () => {
  it("adds the peer cache over existing data; saves, replaces and expires entries", async () => {
    const old = openBefore("0020");
    const s = new Store(old.sql);
    old.db.exec(`
      INSERT INTO server_keys (host, public_key, first_seen, last_seen) VALUES ('a.example', 'K1', 1, 2);
    `);
    expect(migrate(old.db)).toContain("0020_server_info.sql");
    expect(await s.connections.pinnedKey("a.example")).toBe("K1");
    expect(await s.connections.serverInfo("a.example")).toBeUndefined();
    await s.connections.saveServerInfo("a.example", '{"version":1}', 10, 310);
    await s.connections.saveServerInfo("a.example", '{"version":2}', 20, 320);
    expect(await s.connections.serverInfo("a.example")).toEqual({
      doc: '{"version":2}',
      fetchedAt: 20,
      expiresAt: 320,
    });
    await s.connections.expireServerInfo("a.example", 30);
    expect((await s.connections.serverInfo("a.example"))?.expiresAt).toBe(30);
    // Expiring never pushes an already-expired entry's time forward.
    await s.connections.expireServerInfo("a.example", 40);
    expect((await s.connections.serverInfo("a.example"))?.expiresAt).toBe(30);
    expect(await s.connections.serverInfos()).toEqual([
      { host: "a.example", doc: '{"version":2}', fetchedAt: 20 },
    ]);
    old.db.close();
  });
});

describe("0021_voicemail_play", () => {
  it("keeps live tickets and allows play tickets", async () => {
    const old = openBefore("0021");
    const s = new Store(old.sql);
    const t = await s.createVoicemailTicket("voicemail", { a: 1 }, T0);
    expect(migrate(old.db)).toContain("0021_voicemail_play.sql");
    expect(await s.peekVoicemailTicket(t, "voicemail", T0)).toEqual({ a: 1 });
    const p = await s.createVoicemailTicket("play", { voicemailId: "vm_x" }, T0);
    // A play ticket is no upload ticket, and the other way round.
    expect(await s.peekVoicemailTicket(p, "voicemail", T0)).toBeUndefined();
    expect(await s.takeVoicemailTicket(t, "play", T0)).toBeUndefined();
    expect(await s.takeVoicemailTicket(p, "play", T0)).toEqual({ voicemailId: "vm_x" });
    expect(await s.takeVoicemailTicket(p, "play", T0)).toBeUndefined();
    old.db.close();
  });
});

describe("0022_public_lines", () => {
  it("keeps groups, phones and voicemail; line addresses share the handle namespace", async () => {
    const old = openBefore("0022");
    const s = new Store(old.sql);
    const owner = await s.createAccount({ name: "Olga", handle: "olga" }, T0);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Acme", timeZone: "UTC", guardianName: "Olga", accountId: owner?.id, type: "team" },
      T0,
    );
    const group = await s.workplace.createGroup(
      {
        householdId: hh.id,
        name: "Support",
        strategy: "simultaneous",
        ringSeconds: 20,
        members: [guardian.id],
      },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const desk = await s.claimPairing(
      { code, householdId: hh.id, name: "Desk", ownerUserId: guardian.id },
      T0,
    );
    if (!desk) throw new Error("pairing failed");
    // A key, and a handle someone released (it stays theirs for 90 days).
    old.db.exec(`
      INSERT INTO buttons (device_id, idx, user_id) VALUES ('${desk.id}', 0, '${guardian.id}');
      INSERT INTO released_handles (handle, account_id, released_at)
        VALUES ('old-name', '${owner?.id}', ${T0});
    `);
    expect(migrate(old.db)).toContain("0022_public_lines.sql");
    expect((await s.workplace.group(group.id))?.members).toEqual([guardian.id]);
    expect(await s.listButtons(desk.id)).toEqual(new Map([[0, guardian.id]]));
    // Taken by an account, reserved, or free.
    expect(await s.lines.setHandle(group.id, hh.id, "olga", T0)).toBe(false);
    expect(await s.lines.setHandle(group.id, hh.id, "old-name", T0)).toBe(false);
    expect(await s.lines.setHandle(group.id, hh.id, "acme-help", T0)).toBe(true);
    expect(await s.lines.get(group.id)).toMatchObject({
      handle: "acme-help",
      enabled: false,
      who: "anyone",
      queue: true,
      queueMax: 10,
      queueWaitSeconds: 600,
      atMaxWait: { kind: "voicemail" },
    });
    // Now nobody else may take it: not an account, a room or another line.
    expect(await s.handleAvailable("acme-help", T0)).toBe(false);
    expect(
      await s.rooms.create(
        {
          householdId: hh.id,
          kind: "phone",
          name: "Room",
          handle: "acme-help",
          ownerAccount: null,
          access: "space",
        },
        T0,
      ),
    ).toBeUndefined();
    expect(await s.setHandle(owner?.id as string, "acme-help", T0 + 1)).toBe(false);
    // A line on a phone's key, removed with the phone's other entries.
    const ln = await s.lines.addToPhone(desk.id, "Help@Far.Example", "Help");
    await s.setButton(desk.id, 1, ln);
    expect(await s.listButtons(desk.id)).toEqual(
      new Map([
        [0, guardian.id],
        [1, ln],
      ]),
    );
    expect(await s.getContact(desk.id, ln)).toMatchObject({ label: "Help", deviceCanCall: true });
    await s.removeContact(desk.id, ln);
    expect(await s.listButtons(desk.id)).toEqual(new Map([[0, guardian.id]]));
    // Deleting the group drops its line (the address is free again).
    await s.workplace.deleteGroup(group.id);
    expect(await s.lines.byHandle("acme-help")).toBeUndefined();
    old.db.close();
  });
});

describe("0023_line_callbacks", () => {
  it("keeps lines (call me back on, one retry); call backs and grants come and go", async () => {
    const old = openBefore("0023");
    const s = new Store(old.sql);
    const owner = await s.createAccount({ name: "Olga", handle: "olga" }, T0);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Acme", timeZone: "UTC", guardianName: "Olga", accountId: owner?.id, type: "team" },
      T0,
    );
    const group = await s.workplace.createGroup(
      {
        householdId: hh.id,
        name: "Support",
        strategy: "simultaneous",
        ringSeconds: 20,
        members: [guardian.id],
      },
      T0,
    );
    expect(await s.lines.setHandle(group.id, hh.id, "acme-help", T0)).toBe(true);
    old.db.exec(
      `UPDATE public_lines SET enabled = 1, queue_max = 5 WHERE group_id = '${group.id}'`,
    );
    expect(migrate(old.db)).toContain("0023_line_callbacks.sql");
    expect(await s.lines.get(group.id)).toMatchObject({
      handle: "acme-help",
      enabled: true,
      queueMax: 5,
      callback: true,
      callbackMissed: "retry",
    });
    await s.lines.update(group.id, { callback: false, callbackMissed: "voicemail" }, T0);
    expect(await s.lines.get(group.id)).toMatchObject({
      callback: false,
      callbackMissed: "voicemail",
    });
    // The line's side: a place in line, rung, missed (to the end of the line), taken once.
    const row = {
      id: "call_1",
      groupId: group.id,
      householdId: hh.id,
      since: T0,
      host: "far.example",
      accountId: "acc_far",
      handle: "ann",
      name: "Ann",
      address: "Ann@Far.Example",
      expiresAt: T0 + 1000,
    };
    await s.lines.addCallback(row, T0);
    expect(await s.lines.callbacks(hh.id)).toMatchObject([
      { id: "call_1", address: "ann@far.example", attempts: 0, ringingUntil: null },
    ]);
    await s.lines.ringCallback("call_1", T0 + 300);
    expect(await s.lines.nextCallbackDeadline(hh.id)).toBe(T0 + 300);
    await s.lines.ringCallback("call_1", null, T0 + 500);
    expect(await s.lines.callback("call_1")).toMatchObject({ since: T0 + 500, attempts: 1 });
    expect(await s.lines.nextCallbackDeadline(hh.id)).toBe(T0 + 1000);
    expect(await s.lines.takeCallback("call_1")).toBe(true);
    expect(await s.lines.takeCallback("call_1")).toBe(false);
    expect(await s.lines.nextCallbackDeadline(hh.id)).toBeUndefined();
    // The caller's side: only the line they asked, only for them, only until it expires.
    await s.lines.addGrant(
      {
        id: "call_2",
        accountId: owner?.id as string,
        userId: guardian.id,
        householdId: hh.id,
        lineHost: "shop.example",
        lineHandle: "Orders",
        lineName: "Orders",
        expiresAt: T0 + 1000,
      },
      T0,
    );
    expect(await s.lines.grant("call_2", "shop.example", "olga", T0)).toMatchObject({
      userId: guardian.id,
      lineHandle: "orders",
    });
    expect(await s.lines.grant("call_2", "other.example", "olga", T0)).toBeUndefined();
    expect(await s.lines.grant("call_2", "shop.example", "eve", T0)).toBeUndefined();
    expect(await s.lines.grant("call_2", "shop.example", "olga", T0 + 1000)).toBeUndefined();
    await s.lines.sweepCallbacks(T0 + 1000);
    expect(await s.lines.grant("call_2", "shop.example", "olga", T0)).toBeUndefined();
    old.db.close();
  });
});

describe("0024_notices", () => {
  it("two notices posted in the same millisecond: the later one is newer, never a tie", async () => {
    const old = openBefore("0024");
    const s = new Store(old.sql);
    migrate(old.db);
    const owner = await s.createAccount({ name: "Mom", handle: "mom" }, T0);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom", accountId: owner?.id },
      T0,
    );
    const make = (text: string) =>
      s.notices.create(
        {
          householdId: hh.id,
          createdBy: guardian.id,
          authorName: "Mom",
          lines: [text],
          deviceIds: null,
          expiresAt: T0 + 60_000,
        },
        T0,
      );
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await make(`N${i}`)).id);
    const live = await s.notices.live(hh.id, T0 + 1);
    expect(live.map((x) => x.id)).toEqual([...ids].reverse());
    expect(new Set(live.map((x) => x.createdAt)).size).toBe(6);
  });

  it("keeps spaces and phones; notices come, are dismissed per phone, and are swept", async () => {
    const old = openBefore("0024");
    const s = new Store(old.sql);
    const owner = await s.createAccount({ name: "Mom", handle: "mom" }, T0);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom", accountId: owner?.id },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const kitchen = await s.claimPairing({ code, householdId: hh.id, name: "Kitchen" }, T0);
    if (!kitchen) throw new Error("pairing failed");
    expect(migrate(old.db)).toContain("0024_notices.sql");
    expect((await s.getDevice(kitchen.id))?.name).toBe("Kitchen");
    const n = await s.notices.create(
      {
        householdId: hh.id,
        createdBy: guardian.id,
        authorName: "Mom",
        lines: ["DINNER'S READY"],
        deviceIds: null,
        expiresAt: T0 + 60_000,
      },
      T0,
    );
    expect(n).toMatchObject({ lines: ["DINNER'S READY"], deviceIds: null, audio: null });
    const two = await s.notices.create(
      {
        householdId: hh.id,
        createdBy: guardian.id,
        authorName: "Mom",
        lines: ["BUS IS", "HERE"],
        deviceIds: [kitchen.id],
        expiresAt: T0 + 120_000,
      },
      T0 + 1,
    );
    expect((await s.notices.live(hh.id, T0 + 2)).map((x) => x.id)).toEqual([two.id, n.id]);
    const { token } = await s.notices.setAudio(two.id, {
      blobKey: "notice/a",
      mime: "audio/wav",
      durationMs: 2000,
    });
    expect((await s.notices.get(two.id))?.audio).toEqual({
      blobKey: "notice/a",
      mime: "audio/wav",
      durationMs: 2000,
      token,
    });
    expect((await s.notices.get(two.id))?.deviceIds).toEqual([kitchen.id]);
    await s.notices.dismiss(two.id, kitchen.id, T0 + 3);
    await s.notices.dismiss(two.id, kitchen.id, T0 + 4);
    expect(await s.notices.dismissed(kitchen.id, [n.id, two.id])).toEqual(new Set([two.id]));
    // Taken down early (once); its recording is let go, and a week later the row too.
    expect(await s.notices.end(two.id, T0 + 5)).toBe(true);
    expect(await s.notices.end(two.id, T0 + 6)).toBe(false);
    expect(await s.notices.sweep(hh.id, T0 + 7)).toEqual(["notice/a"]);
    expect((await s.notices.get(two.id))?.audio).toBeNull();
    await s.notices.sweep(hh.id, T0 + 8 * 24 * 60 * 60 * 1000);
    expect(await s.notices.ofSpace(hh.id)).toEqual([]);
    old.db.close();
  });
});

describe("0025_room_hours", () => {
  it("keeps rooms (always open); hours and the announced window come and go", async () => {
    const old = openBefore("0025");
    const s = new Store(old.sql);
    const owner = await s.createAccount({ name: "Mom", handle: "mom" }, T0);
    const { household: hh } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom", accountId: owner?.id },
      T0,
    );
    const room = await s.rooms.create(
      {
        householdId: hh.id,
        kind: "party",
        name: "Family line",
        handle: null,
        ownerAccount: owner?.id ?? null,
        access: "space",
      },
      T0,
    );
    if (!room) throw new Error("no room");
    const { code } = await s.createPairing(KEY, T0);
    const kid = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    if (!kid) throw new Error("pairing failed");
    const rk = await s.rooms.addToPhone(kid.id, room.id, "Family");
    expect(migrate(old.db)).toContain("0025_room_hours.sql");
    expect(await s.rooms.get(room.id)).toMatchObject({
      name: "Family line",
      hours: null,
      announcedUntil: null,
    });
    expect(await s.rooms.phonesWith(room.id)).toEqual([kid.id]);
    expect(rk.startsWith("rk_")).toBe(true);
    const hours = [{ days: [1, 3], start: "19:00", end: "21:00" }];
    await s.rooms.setHours(room.id, hours);
    await s.rooms.setAnnounced(room.id, T0 + 1000);
    expect(await s.rooms.get(room.id)).toMatchObject({ hours, announcedUntil: T0 + 1000 });
    // New hours announce afresh; none = always open.
    await s.rooms.setHours(room.id, null);
    expect(await s.rooms.get(room.id)).toMatchObject({ hours: null, announcedUntil: null });
    old.db.close();
  });
});

describe("missed call backs (migration 0026)", () => {
  it("one per person and line, newest first; cleared per line or all; gone with the history", async () => {
    const { household: hh, guardian } = await household();
    const accountId = guardian.accountId;
    const add = (lineAddress: string, lineName: string, at: number) =>
      store.lines.addMissedCallback({ accountId, householdId: hh.id, lineAddress, lineName }, at);
    await add("Help@Acme.example", "Help", T0);
    await add("orders@shop.example", "Orders", T0 + 1);
    await add("help@acme.example", "Help desk", T0 + 2);
    expect(await store.lines.missedCallbacks(accountId)).toEqual([
      {
        id: expect.any(String),
        lineAddress: "help@acme.example",
        lineName: "Help desk",
        at: T0 + 2,
      },
      {
        id: expect.any(String),
        lineAddress: "orders@shop.example",
        lineName: "Orders",
        at: T0 + 1,
      },
    ]);
    expect(await store.lines.clearMissedCallbacks(accountId, "ORDERS@shop.example")).toBe(1);
    expect((await store.lines.missedCallbacks(accountId)).map((m) => m.lineName)).toEqual([
      "Help desk",
    ]);
    // The space keeps history 30 days: older misses go with the sweep.
    await store.setSpacePrivacy(hh.id, { historyDays: 30 });
    await store.sweepExpired(hh.id, "x", T0 + 31 * 24 * 60 * 60 * 1000);
    expect(await store.lines.missedCallbacks(accountId)).toEqual([]);
    await add("help@acme.example", "Help", T0);
    expect(await store.lines.clearMissedCallbacks(accountId)).toBe(1);
  });
});

describe("0027_accounts_recovery", () => {
  it("keeps sessions, invites and spaces; writes down each space's owner", async () => {
    const old = openBefore("0027");
    const s = new Store(old.sql);
    const mom = await s.createAccount({ name: "Mom", handle: "mom" }, T0);
    const dad = await s.createAccount({ name: "Dad", handle: "dad" }, T0);
    if (!mom || !dad) throw new Error("no accounts");
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom", accountId: mom.id },
      T0,
    );
    const dadThere = await s.createUser(
      { householdId: hh.id, name: "Dad", role: "guardian", accountId: dad.id },
      T0 + 1,
    );
    const kid = await s.createUser({ householdId: hh.id, name: "Kid", role: "contact" }, T0 + 2);
    await s.addPasskey({
      id: "pk1",
      accountId: mom.id,
      publicKey: KEY,
      counter: 0,
      transports: [],
      name: "Mac",
      createdAt: T0,
    });
    // Sessions and an invite as 0026 stored them.
    const raw = (table: string, cols: string[], values: unknown[]) =>
      old.sql.run(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ...(values as (string | number | null)[]),
      );
    const sessionCols = ["token_hash", "account_id", "user_id", "created_at", "expires_at"];
    await raw("sessions", sessionCols, [
      await sha256("t-mom-1".repeat(4)),
      mom.id,
      guardian.id,
      T0,
      T0 + SESSION_TTL_MS,
    ]);
    await raw("sessions", sessionCols, [
      await sha256("t-mom-2".repeat(4)),
      mom.id,
      guardian.id,
      T0,
      T0 + SESSION_TTL_MS,
    ]);
    await raw("sessions", sessionCols, [
      await sha256("t-dad-1".repeat(4)),
      dad.id,
      dadThere.id,
      T0,
      T0 + SESSION_TTL_MS,
    ]);
    await raw(
      "invites",
      [
        "token_hash",
        "household_id",
        "user_id",
        "name",
        "role",
        "created_by",
        "created_at",
        "expires_at",
      ],
      [await sha256("invite-token"), hh.id, kid.id, "Kid", "contact", guardian.id, T0, T0 + 1000],
    );
    expect(migrate(old.db)).toContain("0027_accounts_recovery.sql");

    // Owner: the space's first guardian, written down.
    const row = await old.sql.first<{ owner_user: string }>(
      "SELECT owner_user FROM households WHERE id = ?",
      hh.id,
    );
    expect(row?.owner_user).toBe(guardian.id);
    expect(await s.spaceOwnerUser(hh.id)).toBe(guardian.id);
    expect(await s.spaceOwner(hh.id)).toBe(mom.id);
    // Sessions still sign in; each has its own id; Mom's (she has a passkey) slide, Dad's don't.
    const m1 = await s.sessionForToken("t-mom-1".repeat(4), T0 + 10);
    const m2 = await s.sessionForToken("t-mom-2".repeat(4), T0 + 10);
    const d1 = await s.sessionForToken("t-dad-1".repeat(4), T0 + 10);
    expect(m1?.user?.id).toBe(guardian.id);
    expect(m1?.session.id).toMatch(/^ses_[0-9a-f]{24}$/);
    expect(m1?.session.id).not.toBe(m2?.session.id);
    expect(m1?.session).toMatchObject({ passkey: true, limited: false, via: null });
    expect(d1?.session).toMatchObject({ passkey: false, limited: false });
    expect((await s.auth.sessions(mom.id, T0 + 10)).map((x) => x.id).sort()).toEqual(
      [m1?.session.id, m2?.session.id].sort(),
    );
    // The invite works, now with an id the guardians' list can cancel it by.
    const invite = await s.peekInvite("invite-token", T0 + 10);
    expect(invite).toMatchObject({ userId: kid.id, createdBy: guardian.id });
    expect(invite?.id).toMatch(/^inv_[0-9a-f]{24}$/);
    expect((await s.auth.invites(hh.id, T0 + 10)).map((i) => i.id)).toEqual([invite?.id]);
    // No account has a recovery code yet.
    expect((await s.getAccount(mom.id))?.hasRecoveryCode).toBe(false);
    old.db.close();
  });
});

describe("sign-in records", () => {
  it("recovery codes work once, and only for their own account", async () => {
    const { guardian } = await household();
    const code = "A".repeat(28);
    await store.auth.setRecoveryCode(guardian.accountId, code, T0);
    expect((await store.getAccount(guardian.accountId))?.hasRecoveryCode).toBe(true);
    const stored = db
      .prepare("SELECT recovery_hash FROM accounts WHERE id = ?")
      .get(guardian.accountId) as { recovery_hash: string };
    // Only a hash is kept.
    expect(stored?.recovery_hash).not.toContain(code);
    expect(await store.auth.checkRecoveryCode(guardian.accountId, "B".repeat(28))).toBe(false);
    expect(await store.auth.checkRecoveryCode(undefined, code)).toBe(false);
    expect(await store.auth.checkRecoveryCode("acc_other", code)).toBe(false);
    // Checking leaves it valid; using it up works once.
    expect(await store.auth.checkRecoveryCode(guardian.accountId, code)).toBe(true);
    expect(await store.auth.checkRecoveryCode(guardian.accountId, code)).toBe(true);
    expect(await store.auth.consumeRecoveryCode(guardian.accountId)).toBe(true);
    expect(await store.auth.consumeRecoveryCode(guardian.accountId)).toBe(false);
    expect(await store.auth.checkRecoveryCode(guardian.accountId, code)).toBe(false);
    expect((await store.getAccount(guardian.accountId))?.hasRecoveryCode).toBe(false);
  });

  it("sessions slide once a day while in use, only when a passkey backs them", async () => {
    const { guardian } = await household();
    const day = 24 * 60 * 60 * 1000;
    const backed = await store.createAccountSession(guardian.accountId, guardian.id, T0, {
      passkey: true,
    });
    const bare = await store.createAccountSession(guardian.accountId, guardian.id, T0);
    const later = await store.sessionForToken(backed, T0 + 80 * day);
    expect(later?.session.expiresAt).toBe(T0 + 80 * day + SESSION_TTL_MS);
    expect((await store.sessionForToken(bare, T0 + 80 * day))?.session.expiresAt).toBe(
      T0 + SESSION_TTL_MS,
    );
    // Unused for the whole window: gone.
    expect(await store.sessionForToken(bare, T0 + SESSION_TTL_MS)).toBeUndefined();
    expect(await store.sessionForToken(backed, T0 + 80 * day + SESSION_TTL_MS - 1)).toBeDefined();
    // Expired sessions are purged by the sweep.
    await store.auth.purgeExpired(T0 + SESSION_TTL_MS);
    expect(await store.auth.sessions(guardian.accountId, 0)).toHaveLength(1);
  });
});

describe("0028 add-ons", () => {
  it("keeps everything as it was; add-ons link only with an add-on's code and go with their owner", async () => {
    const old = openBefore("0028");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code: phoneCode } = await s.createPairing(KEY, T0);
    const phone = await s.claimPairing({ code: phoneCode, householdId: hh.id, name: "Kid" }, T0);
    const bob = await s.createAccount({ name: "Bob", handle: "bob" }, T0);
    old.db.exec(`
      INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
        state, direction, created_at, updated_at) VALUES ('con_1', '${guardian.accountId}', '',
        'bob', '${bob?.id}', 'Bob', 'active', 'none', 1, 1);
    `);
    const pending = await s.createPairing("p".repeat(43), T0);
    expect(migrate(old.db)).toContain("0028_addons.sql");
    expect(await s.getDevice(phone?.id ?? "")).toMatchObject({ name: "Kid", kind: "kids" });
    expect((await s.connections.get("con_1"))?.state).toBe("active");
    // A phone's code stays a phone's: it can't be linked as an add-on.
    const who = { accountId: guardian.accountId, householdId: hh.id, userId: guardian.id };
    expect(await s.addons.link({ ...who, code: pending.code, name: "seat" }, T0)).toBe("no_code");

    const { code } = await s.createPairing("a".repeat(43), T0, "ed25519", "addon");
    expect(await s.peekPairing(code, T0)).toMatchObject({ addon: true, mode: null });
    // …and an add-on's code is never a phone's.
    expect(await s.claimPairing({ code, householdId: hh.id, name: "x" }, T0)).toBeUndefined();
    const addon = await s.addons.link({ ...who, code, name: "Seat" }, T0);
    if (typeof addon === "string") throw new Error(addon);
    expect(addon).toMatchObject({ name: "seat", accountId: guardian.accountId });
    const account = await s.getAccount(guardian.accountId);
    expect((await s.addons.byAddress(account?.handle ?? "", "SEAT"))?.id).toBe(addon.id);
    expect(await s.addons.byAddress("bob", "seat")).toBeUndefined();
    // A second link with the same name is refused; the first code was single use.
    const { code: code2 } = await s.createPairing("b".repeat(43), T0, "ed25519", "addon");
    expect(await s.addons.link({ ...who, code: code2, name: "seat" }, T0)).toBe("name_taken");
    expect(await s.addons.link({ ...who, code, name: "other" }, T0)).toBe("no_code");
    // The owner leaving the space it was linked in removes it.
    old.db.exec(`DELETE FROM users WHERE id = '${guardian.id}'`);
    expect(await s.addons.get(addon.id)).toBeUndefined();
    old.db.close();
  });
});

describe("0029 missed calls and call waiting", () => {
  it("keeps everything as it was; call waiting is on; missed calls group, clear and expire", async () => {
    const old = openBefore("0029");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const kid = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    if (!kid) throw new Error("no phone");
    await s.logCall({
      householdId: hh.id,
      accountId: guardian.accountId,
      deviceId: null,
      peer: `device:${kid.id}`,
      peerLabel: "Kid",
      direction: "in",
      startedAt: T0,
      answered: false,
      durationMs: 0,
      endReason: "timeout",
      callId: "call_old",
    });
    expect(migrate(old.db)).toContain("0029_missed_calls.sql");
    expect(await s.getDevice(kid.id)).toMatchObject({ name: "Kid", kind: "kids" });
    // Call waiting is on for everyone until they turn it off.
    expect(await s.callWaiting({ accountId: guardian.accountId })).toBe(true);
    expect(await s.callWaiting({ deviceId: kid.id })).toBe(true);
    await s.setCallWaiting({ deviceId: kid.id }, false);
    expect(await s.callWaiting({ deviceId: kid.id })).toBe(false);
    expect(await s.callWaiting({ accountId: guardian.accountId })).toBe(true);

    const me = { accountId: guardian.accountId };
    const add = (from: string, label: string, at: number, callId = `c${at}`) =>
      s.missed.add({ householdId: hh.id, owner: me, callId, fromLabel: label, fromPeer: from, at });
    await add("user:u1", "Ana", T0 + 1);
    const newestAna = await add("user:u1", "Ana", T0 + 3);
    await add("bob@b.test", "Bob", T0 + 2);
    await s.missed.add({
      householdId: hh.id,
      owner: { deviceId: kid.id },
      callId: "c9",
      fromLabel: "Mom",
      fromPeer: `user:${guardian.id}`,
      at: T0 + 4,
    });
    expect(await s.missed.list(me)).toEqual([
      expect.objectContaining({ id: newestAna, fromLabel: "Ana", count: 2, at: T0 + 3 }),
      expect.objectContaining({ fromPeer: "bob@b.test", count: 1 }),
    ]);
    expect(await s.missed.list({ deviceId: kid.id })).toEqual([
      expect.objectContaining({ fromLabel: "Mom", count: 1 }),
    ]);
    // A message left after Bob's call moves that call to voicemail.
    expect(await s.missed.becameVoicemail(me, "bob@b.test", T0, T0 + 10)).toBe(true);
    expect((await s.missed.list(me)).map((g) => g.fromLabel)).toEqual(["Ana"]);
    // Clearing marks them seen everywhere; the rows stay (call back proof) until they expire.
    expect(await s.missed.clear(me, T0 + 20)).toBe(2);
    expect(await s.missed.list(me)).toEqual([]);
    expect((await s.missed.get(newestAna))?.seenAt).toBe(T0 + 20);
    expect(await s.missed.list({ deviceId: kid.id })).toHaveLength(1);
    expect(await s.missed.ofAccount(guardian.accountId)).toHaveLength(3);
    await s.setSpacePrivacy(hh.id, { historyDays: 30 });
    await s.sweepExpired(hh.id, "home.test", T0 + 31 * 24 * 60 * 60 * 1000);
    expect(await s.missed.ofAccount(guardian.accountId)).toEqual([]);
    expect(await s.missed.list({ deviceId: kid.id })).toEqual([]);
    old.db.close();
  });
});

describe("0030 home features", () => {
  it("keeps phones as they were, all off; a check-in alerts once a day; one intercom key", async () => {
    const old = openBefore("0030");
    const s = new Store(old.sql);
    const { household: hh } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const kid = await s.claimPairing({ code, householdId: hh.id, name: "Gran" }, T0);
    if (!kid) throw new Error("no phone");
    expect(migrate(old.db)).toContain("0030_home_features.sql");
    expect(await s.getDevice(kid.id)).toMatchObject({ name: "Gran", kind: "kids" });
    expect(await s.home.get(kid.id)).toEqual({
      checkinBy: null,
      checkinOkDay: null,
      checkinAlertDay: null,
      chimeText: null,
      intercom: false,
    });
    expect(await s.home.checkins(hh.id)).toEqual([]);
    await s.home.set(kid.id, { checkinBy: "10:00", chimeText: "DINNER'S READY", intercom: true });
    expect(await s.home.checkins(hh.id)).toEqual([
      expect.objectContaining({ deviceId: kid.id, checkinBy: "10:00", intercom: true }),
    ]);
    expect(await s.home.alerted(kid.id, "2026-10-14")).toBe(true);
    expect(await s.home.alerted(kid.id, "2026-10-14")).toBe(false);
    expect(await s.home.alerted(kid.id, "2026-10-15")).toBe(true);
    await s.home.checkedIn(kid.id, "2026-10-15");
    expect((await s.home.get(kid.id)).checkinOkDay).toBe("2026-10-15");
    // A new time starts afresh.
    await s.home.set(kid.id, { checkinBy: "11:00" });
    expect((await s.home.get(kid.id)).checkinAlertDay).toBeNull();
    const key = await s.home.intercomKey(hh.id);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await s.home.intercomKey(hh.id)).toBe(key);
    old.db.close();
  });
});

describe("0031 add-on shares", () => {
  it("drops the old allow-list (with a note for its owners); shares, grants and requests", async () => {
    const old = openBefore("0031");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const bob = await s.createAccount({ name: "Bob", handle: "bob" }, T0);
    if (!bob) throw new Error("no bob");
    old.db.exec(`
      INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
        state, direction, created_at, updated_at) VALUES ('con_1', '${guardian.accountId}',
        'b.test', 'bob', 'acc_remote', 'Bob', 'active', 'none', 1, 1);
    `);
    const who = { accountId: guardian.accountId, householdId: hh.id, userId: guardian.id };
    const link = async (key: string, name: string) => {
      const { code } = await s.createPairing(key.repeat(43), T0, "ed25519", "addon");
      const a = await s.addons.link({ ...who, code, name }, T0);
      if (typeof a === "string") throw new Error(a);
      return a;
    };
    const seat = await link("a", "seat");
    const notes = await link("b", "notes");
    old.db.exec(`INSERT INTO addon_allow (addon_id, connection_id) VALUES ('${seat.id}', 'con_1')`);
    expect(migrate(old.db)).toContain("0031_addon_shares.sql");
    // The allow-list is gone; the add-on that had one carries the note, the other doesn't.
    expect(old.db.prepare("SELECT COUNT(*) AS n FROM addon_allow").get()).toEqual({ n: 0 });
    expect(await s.addons.allowNote(seat.id)).toBe(true);
    expect(await s.addons.allowNote(notes.id)).toBe(false);
    await s.addons.dismissAllowNote(seat.id);
    expect(await s.addons.allowNote(seat.id)).toBe(false);
    expect(await s.addons.get(seat.id)).toMatchObject({ name: "seat", accountId: who.accountId });
    // Shares start empty; the add-on's list is taken as it is, duplicates once.
    expect(await s.addons.shares(seat.id)).toEqual([]);
    await s.addons.setShares(seat.id, [
      { id: "bookclub", label: "Book club" },
      { id: "garden", label: "Garden" },
      { id: "bookclub", label: "Again" },
    ]);
    expect(await s.addons.shares(seat.id)).toEqual([
      { id: "bookclub", label: "Book club" },
      { id: "garden", label: "Garden" },
    ]);
    // Grants: only to a share it offers; giving twice keeps the first.
    const local = { host: "", accountId: bob.id, handle: "bob", name: "Bob", connectionId: null };
    const remote = {
      host: "b.test",
      accountId: "acc_remote",
      handle: "bob",
      name: "Bob",
      connectionId: "con_1",
    };
    expect(await s.addons.grant(seat.id, "nope", local, T0)).toBeUndefined();
    const g1 = await s.addons.grant(seat.id, "bookclub", local, T0);
    expect(g1).toMatchObject({ shareId: "bookclub", host: "", accountId: bob.id });
    expect((await s.addons.grant(seat.id, "bookclub", local, T0 + 1))?.id).toBe(g1?.id);
    const g2 = await s.addons.grant(seat.id, "garden", local, T0);
    const g3 = await s.addons.grant(seat.id, "bookclub", remote, T0);
    expect(await s.addons.heldBy(bob.id)).toEqual([
      expect.objectContaining({ id: g1?.id, label: "Book club", addonName: "seat" }),
      expect.objectContaining({ id: g2?.id, label: "Garden", ownerAccountId: who.accountId }),
    ]);
    expect(await s.addons.givenTo(who.accountId, "b.test", "acc_remote")).toEqual([
      { addon: "seat", share: "bookclub", label: "Book club" },
    ]);
    // A label changes in place; a share it drops takes its grants.
    const dropped = await s.addons.setShares(seat.id, [{ id: "bookclub", label: "Book Club" }]);
    expect(dropped).toEqual({
      removed: ["garden"],
      revoked: [expect.objectContaining({ id: g2?.id })],
    });
    expect((await s.addons.heldBy(bob.id)).map((h) => h.label)).toEqual(["Book Club"]);
    // Sent again, it starts with nobody.
    await s.addons.setShares(seat.id, [
      { id: "bookclub", label: "Book Club" },
      { id: "garden", label: "Garden" },
    ]);
    expect(await s.addons.grantFor(seat.id, "garden", "", bob.id)).toBeUndefined();
    // Revoking, and a connection that goes, take grants.
    expect(await s.addons.revoke(g1?.id ?? "")).toBe(true);
    expect(await s.addons.revoke(g1?.id ?? "")).toBe(false);
    expect(await s.addons.getGrant(g3?.id ?? "")).toBeDefined();
    await s.connections.delete("con_1");
    expect(await s.addons.getGrant(g3?.id ?? "")).toBeUndefined();
    // Shares another server told us about, per connection.
    old.db.exec(`
      INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
        state, direction, created_at, updated_at) VALUES ('con_2', '${guardian.accountId}',
        'c.test', 'cy', 'acc_cy', 'Cy', 'active', 'none', 1, 1);
    `);
    await s.addons.setReceived("con_2", [{ addon: "seat", share: "x", label: "X" }]);
    expect(await s.addons.received("con_2")).toEqual([{ addon: "seat", share: "x", label: "X" }]);
    await s.addons.setReceived("con_2", []);
    expect(await s.addons.received("con_2")).toEqual([]);
    // Requests settle once.
    const req = await s.addons.createRequest(
      { addonId: seat.id, label: "Garden", holders: [local], state: "waiting" },
      T0,
    );
    expect(req).toMatchObject({ state: "waiting", holders: [local], answeredAt: null });
    expect(
      await s.addons.settleRequest(req.id, { state: "created", shareId: "garden" }, T0 + 1),
    ).toBe(true);
    expect(await s.addons.settleRequest(req.id, { state: "timeout" }, T0 + 2)).toBe(false);
    expect(await s.addons.getRequest(req.id)).toMatchObject({
      state: "created",
      shareId: "garden",
    });
    // Removing the add-on takes its shares, grants and requests.
    await s.addons.grant(seat.id, "garden", local, T0);
    await s.addons.delete(seat.id);
    expect(await s.addons.heldBy(bob.id)).toEqual([]);
    expect(await s.addons.shares(seat.id)).toEqual([]);
    expect(await s.addons.getRequest(req.id)).toBeUndefined();
    old.db.close();
  });
});

describe("0032 add-on about and mutes", () => {
  it("keeps linked add-ons, shares and grants; adds what they say and holders' mutes", async () => {
    const old = openBefore("0032");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const bob = await s.createAccount({ name: "Bob", handle: "bob" }, T0);
    if (!bob) throw new Error("no bob");
    const { code } = await s.createPairing("a".repeat(43), T0, "ed25519", "addon");
    const seat = await s.addons.link(
      {
        accountId: guardian.accountId,
        householdId: hh.id,
        userId: guardian.id,
        code,
        name: "seat",
      },
      T0,
    );
    if (typeof seat === "string") throw new Error(seat);
    await s.addons.setShares(seat.id, [{ id: "bookclub", label: "Book club" }]);
    const local = { host: "", accountId: bob.id, handle: "bob", name: "Bob", connectionId: null };
    const g = await s.addons.grant(seat.id, "bookclub", local, T0);
    expect(migrate(old.db)).toContain("0032_addon_about.sql");
    // As it was, and it hasn't said anything yet.
    expect(await s.addons.get(seat.id)).toMatchObject({ name: "seat", about: null });
    expect(await s.addons.getGrant(g?.id ?? "")).toMatchObject({ shareId: "bookclub" });
    const about = {
      hears: "nothing" as const,
      transcribes: false,
      answers: true,
      calls: false,
      shares: true,
      keys: false,
      lines: 5,
      summary: "Plays the station.",
    };
    await s.addons.setAbout(seat.id, about);
    expect((await s.addons.get(seat.id))?.about).toEqual(about);
    // A holder stops its calls, and starts them again.
    const who = { host: "", ownerAccount: guardian.accountId, name: "Seat" };
    expect(await s.addons.muted(bob.id, who)).toBe(false);
    await s.addons.setMuted(bob.id, who, true, T0);
    await s.addons.setMuted(bob.id, who, true, T0);
    expect(await s.addons.muted(bob.id, who)).toBe(true);
    expect(await s.addons.mutes(bob.id)).toEqual([
      { host: "", ownerAccount: guardian.accountId, name: "seat" },
    ]);
    await s.addons.setMuted(bob.id, who, false, T0);
    expect(await s.addons.muted(bob.id, who)).toBe(false);
    // A holder gives a share back: only their own grant.
    expect(await s.addons.leave(g?.id ?? "", guardian.accountId)).toBe(false);
    expect(await s.addons.leave(g?.id ?? "", bob.id)).toBe(true);
    expect(await s.addons.grants(seat.id)).toEqual([]);
    // Contacts: by address, one row each, removable.
    await s.addons.setContact(bob.id, "Mom+Seat@x", "seat", T0);
    await s.addons.setContact(bob.id, "mom+seat@x", "Seat", T0);
    expect(await s.addons.contacts(bob.id)).toEqual([{ address: "mom+seat@x", label: "Seat" }]);
    await s.addons.removeContact(bob.id, "MOM+SEAT@x");
    expect(await s.addons.contacts(bob.id)).toEqual([]);
    old.db.close();
  });
});

describe("0033 speed-dial pages", () => {
  it("keeps every phone's keys and allows keys 0-99", async () => {
    const old = openBefore("0033");
    const s = new Store(old.sql);
    const { household: hh, guardian } = await s.createHousehold(
      { name: "Home", timeZone: "UTC", guardianName: "Mom" },
      T0,
    );
    const { code } = await s.createPairing(KEY, T0);
    const device = await s.claimPairing({ code, householdId: hh.id, name: "Kid" }, T0);
    if (!device) throw new Error("no phone");
    const bob = await s.createAccount({ name: "Bob", handle: "bob" }, T0);
    old.db.exec(`
      INSERT INTO connections (id, account_id, peer_host, peer_handle, peer_account, peer_name,
        state, direction, created_at, updated_at) VALUES ('con_1', '${guardian.accountId}', '',
        'bob', '${bob?.id}', 'Bob', 'active', 'none', 1, 1);
    `);
    await s.upsertContact(device.id, {
      id: guardian.id,
      label: "Mom",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    const rc = await s.upsertRemoteContact(device.id, "con_1", {
      label: "Bob",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    });
    const room = await s.rooms.create(
      {
        householdId: hh.id,
        kind: "party",
        name: "Den",
        handle: null,
        ownerAccount: guardian.accountId,
        access: "space",
      },
      T0,
    );
    if (!room) throw new Error("no room");
    const rk = await s.rooms.addToPhone(device.id, room.id, "Den");
    const ln = await s.lines.addToPhone(device.id, "help@x.example", "Help");
    await s.setButton(device.id, 0, guardian.id);
    await s.setButton(device.id, 12, rc); // keys 10-15 were allowed (no app set them)
    await s.setButton(device.id, 5, rk);
    await s.setButton(device.id, 9, ln);
    // Before: nothing past 15.
    await expect(s.setButton(device.id, 16, guardian.id)).rejects.toThrow();
    expect(migrate(old.db)).toEqual(["0033_key_pages.sql"]);
    expect([...(await s.listButtons(device.id))]).toEqual([
      [0, guardian.id],
      [5, rk],
      [9, ln],
      [12, rc],
    ]);
    // After: ten pages of ten, of every kind.
    await s.setButton(device.id, 99, guardian.id);
    await s.setButton(device.id, 98, rc);
    await s.setButton(device.id, 57, rk);
    await s.setButton(device.id, 40, ln);
    await expect(s.setButton(device.id, 100, guardian.id)).rejects.toThrow();
    await expect(s.setButton(device.id, 100, rc)).rejects.toThrow();
    expect((await s.listButtons(device.id)).get(99)).toBe(guardian.id);
    expect((await s.listButtons(device.id)).size).toBe(8);
    // Still cascades with the phone and the person.
    await s.removeContact(device.id, guardian.id);
    expect((await s.listButtons(device.id)).has(99)).toBe(false);
    old.db.close();
  });
});
