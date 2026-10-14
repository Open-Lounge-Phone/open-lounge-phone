// The audit trail in every space (docs/security-model.md "Audit trail"): homes log what teams
// log, only the space's guardians (or owner and admins) read it, nothing edits it, entries hold
// no content, and a failed write is an error an operator sees.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditDetail } from "./audit.ts";
import { expectStatus, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

type Entry = { action: string; actorName: string; detail: Record<string, unknown> | null };
const trail = async (token: string, household?: string) => {
  const r = await s.http("/space/audit", { token, ...(household ? { household } : {}) });
  expectStatus(r, 200);
  return r.json as Entry[];
};

/** Mom (guardian) and Dad (a grown-up member, not a guardian) at home, with a kid's phone. */
async function home() {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "contact" },
    s.timers.now,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  const p = await s.pairDevice(mom.token, "Kid phone");
  if (!p.deviceId) throw new Error("pairing failed");
  return { mom, dad, dadToken, kid: p.deviceId };
}

describe("audit trail in homes", () => {
  it("logs what a guardian changes: phones, the kid's allow-list and keys, quiet hours, invites, privacy, notices", async () => {
    const { mom, dad, kid } = await home();
    const contact = { label: "Dad", canCallDevice: true, deviceCanCall: true };
    expectStatus(
      await s.http(`/devices/${kid}/contacts/${dad.id}`, {
        method: "PUT",
        token: mom.token,
        body: { ...contact, bypassQuietHours: false },
      }),
      204,
    );
    expectStatus(
      await s.http(`/devices/${kid}/buttons/1`, {
        method: "PUT",
        token: mom.token,
        body: { userId: dad.id },
      }),
      204,
    );
    expectStatus(
      await s.http(`/devices/${kid}`, { method: "PATCH", token: mom.token, body: { name: "Ana" } }),
      204,
    );
    expectStatus(
      await s.http("/quiet-hours", {
        method: "PUT",
        token: mom.token,
        body: { rules: [{ days: [1, 2, 3, 4, 5], start: "20:00", end: "07:00" }] },
      }),
      204,
    );
    expectStatus(
      await s.http("/invites", { token: mom.token, body: { name: "Gran", role: "contact" } }),
      201,
    );
    expectStatus(
      await s.http("/space/privacy", { method: "PUT", token: mom.token, body: { history: "1y" } }),
      204,
    );
    expectStatus(
      await s.http("/notices", { token: mom.token, body: { text: "Bus is here" } }),
      201,
    );
    expectStatus(
      await s.http(`/devices/${kid}/contacts/${dad.id}`, { method: "DELETE", token: mom.token }),
      204,
    );
    const entries = await trail(mom.token);
    expect(entries.map((e) => e.action)).toEqual([
      "phone.contact.remove",
      "notice.post",
      "privacy.update",
      "invite.create",
      "quiet.update",
      "phone.rename",
      "phone.key",
      "phone.contact",
      "phone.add",
    ]);
    expect(entries.every((e) => e.actorName === "Mom")).toBe(true);
    expect(entries.find((e) => e.action === "phone.key")?.detail).toEqual({
      deviceId: kid,
      phone: "Kid phone",
      index: 1,
      contactId: dad.id,
    });
    expect(entries.find((e) => e.action === "quiet.update")?.detail).toEqual({ rules: 1 });
  });

  it("never stores what a notice says (nor any other content)", async () => {
    const { mom } = await home();
    const r = await s.http("/notices", { token: mom.token, body: { text: "Bus is here" } });
    expectStatus(r, 201);
    expectStatus(
      await s.http(`/notices/${r.json.id}`, { method: "DELETE", token: mom.token }),
      204,
    );
    const rows = await s.sql.all<Record<string, unknown>>("SELECT * FROM audit_log");
    const notices = rows.filter((row) => String(row.action).startsWith("notice."));
    expect(notices.map((row) => row.action)).toEqual(["notice.post", "notice.delete"]);
    for (const row of notices) expect(JSON.stringify(row)).not.toMatch(/bus is here/i);
    // The backstop drops content and secrets at any depth, whatever a call site passes.
    expect(
      auditDetail({
        noticeId: "n1",
        lines: ["HI"],
        nested: { text: "x", token: "t", ip: "1.2.3.4", kept: 1 },
        list: [{ transcript: "y", id: "v1" }],
      }),
    ).toEqual({ noticeId: "n1", nested: { kept: 1 }, list: [{ id: "v1" }] });
  });

  it("a person's changes to their own phone aren't the space's business", async () => {
    const { mom, dadToken } = await home();
    const mine = await s.pairDevice(dadToken, "Dad's desk", { forMe: true });
    if (!mine.deviceId) throw new Error("pairing failed");
    expectStatus(
      await s.http(`/devices/${mine.deviceId}/buttons/2`, {
        method: "PUT",
        token: dadToken,
        body: { userId: mom.user.id },
      }),
      204,
    );
    expect((await trail(mom.token)).map((e) => e.action)).not.toContain("phone.key");
  });

  it("goes with the home's history retention, like a team's", async () => {
    const { mom } = await home();
    expectStatus(
      await s.http("/space/privacy", { method: "PUT", token: mom.token, body: { history: "30d" } }),
      204,
    );
    expect((await trail(mom.token)).length).toBeGreaterThan(0);
    s.timers.advance(31 * 24 * 60 * 60 * 1000);
    await s.store.sweepExpired(mom.household.id, "home.test", s.timers.now);
    expect(await trail(mom.token)).toEqual([]);
  });

  it("a failed write doesn't stop the change and is logged as an error", async () => {
    const log = vi.fn();
    s = new TestServer({ publicUrl: "https://home.test", env: { log } });
    const mom = await s.person("mom", "Mom");
    vi.spyOn(s.store.workplace, "audit").mockRejectedValue(new Error("disk full"));
    expectStatus(
      await s.http("/quiet-hours", { method: "PUT", token: mom.token, body: { rules: [] } }),
      204,
    );
    expect(log).toHaveBeenCalledWith(
      "error",
      "audit write failed",
      expect.objectContaining({ action: "quiet.update", household: mom.household.id }),
    );
  });
});

describe("who reads the audit trail", () => {
  it("a home's guardians; never its other members", async () => {
    const { mom, dadToken } = await home();
    expect((await trail(mom.token)).length).toBeGreaterThan(0);
    expectStatus(await s.http("/space/audit", { token: dadToken }), 403);
  });

  it("a team's owner and admins; never its members", async () => {
    const olga = await s.person("olga", "Olga", "team");
    const add = async (name: string, role: "guardian" | "contact") => {
      const user = await s.store.createUser(
        { householdId: olga.household.id, name, role },
        s.timers.now,
      );
      return s.store.createSession(user.id, s.timers.now);
    };
    const ada = await add("Ada", "guardian");
    const ben = await add("Ben", "contact");
    expectStatus(
      await s.http("/space/privacy", { method: "PUT", token: ada, body: { history: "1y" } }),
      204,
    );
    expect((await trail(olga.token)).map((e) => e.action)).toEqual(["privacy.update"]);
    expect((await trail(ada)).map((e) => e.action)).toEqual(["privacy.update"]);
    expectStatus(await s.http("/space/audit", { token: ben }), 403);
  });

  it("only your own space's: another space's guardian sees none of it, even naming it", async () => {
    const { mom } = await home();
    const other = await s.person("zed", "Zed");
    const theirs = await trail(other.token);
    expect(theirs).toEqual([]);
    // Pinning Mom's household from Zed's session is refused outright.
    const r = await s.http("/space/audit", { token: other.token, household: mom.household.id });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.json)).not.toContain("phone.add");
  });

  it("nothing edits or deletes it, and no other server can ask for it", async () => {
    const { mom } = await home();
    const [first] = await s.store.workplace.auditLog(mom.household.id);
    for (const method of ["DELETE", "PUT", "PATCH", "POST"]) {
      for (const path of ["/space/audit", `/space/audit/${first?.id}`]) {
        const r = await s.api.request(path, {
          method,
          headers: { authorization: `Bearer ${mom.token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "x" }),
        });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    }
    expect((await trail(mom.token)).map((e) => e.action)).toEqual(["phone.add"]);
    for (const path of ["/fed/v1/audit", "/fed/v1/space/audit", "/.well-known/audit"]) {
      expect((await s.root.request(path)).status, path).toBe(404);
    }
  });
});
