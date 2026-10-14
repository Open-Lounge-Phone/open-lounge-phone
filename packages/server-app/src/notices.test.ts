// Notices (docs/notices.md): posted by a space's guardians (owner and admins in a team), shown
// on its phones, with an optional recording, dismissed per phone, gone when they expire.
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, TestServer } from "./testkit.ts";

let s: TestServer;
beforeEach(() => {
  s = new TestServer({ publicUrl: "https://home.test" });
});

/** Mom (guardian) and Dad (a grown-up member) at home, with two kids' phones online. */
async function home() {
  const mom = await s.person("mom", "Mom");
  const dad = await s.store.createUser(
    { householdId: mom.household.id, name: "Dad", role: "contact" },
    s.timers.now,
  );
  const dadToken = await s.store.createSession(dad.id, s.timers.now);
  const phone = async (name: string) => {
    const p = await s.pairDevice(mom.token, name);
    if (!p.deviceId || !p.key) throw new Error("pairing failed");
    return { id: p.deviceId, key: p.key, conn: await s.connectDevice(p.deviceId, p.key.pair) };
  };
  return { mom, dadToken, kitchen: await phone("Kitchen"), hall: await phone("Hall") };
}

const post = (token: string, body: unknown) => s.http("/notices", { token, body });

describe("notices", () => {
  it("a guardian posts one; every phone shows it; members can't post", async () => {
    const { mom, dadToken, kitchen, hall } = await home();
    expectStatus(await post(dadToken, { text: "Dinner's ready" }), 403);
    expectStatus(await post(mom.token, { text: "far too long for one line" }), 400);
    const r = await post(mom.token, { text: "Dinner's ready" });
    expectStatus(r, 201);
    expect(r.json).toMatchObject({ lines: ["DINNER'S READY"], from: "Mom", live: true });
    for (const p of [kitchen, hall]) {
      const n = await p.conn.next("notice");
      expect(n).toEqual({
        t: "notice",
        id: r.json.id,
        lines: ["DINNER'S READY"],
        from: "Mom",
        at: s.timers.now,
        expiresAt: s.timers.now + 60 * 60_000,
      });
    }
    // A phone that connects later gets it too.
    const late = await s.pairDevice(mom.token, "Porch");
    if (!late.deviceId || !late.key) throw new Error("pairing failed");
    const porch = await s.connectDevice(late.deviceId, late.key.pair);
    expect((await porch.next("notice")).id).toBe(r.json.id);
  });

  it("a recording: sent again with its token (phones play it), and only while it lasts", async () => {
    const { mom, kitchen } = await home();
    const r = await post(mom.token, { text: "Bus is here", minutes: 5 });
    const first = await kitchen.conn.next("notice");
    expect(first.audio).toBeUndefined();
    const up = await s.http(`/notices/${r.json.id}/audio?durationMs=2000`, {
      method: "PUT",
      token: mom.token,
      raw: new Uint8Array([1, 2, 3, 4]),
      type: "audio/wav",
    });
    expectStatus(up, 204);
    const again = await kitchen.conn.next("notice");
    expect(again).toMatchObject({ id: r.json.id, audio: { durationMs: 2000 } });
    const token = again.audio?.token as string;
    const play = await s.api.request(`/notices/${r.json.id}/audio?token=${token}`);
    expect(play.status).toBe(200);
    expect(new Uint8Array(await play.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect((await s.api.request(`/notices/${r.json.id}/audio?token=x${token}`)).status).toBe(404);
    // Five minutes later it's gone from the phones, and so is the recording.
    s.timers.advance(5 * 60_000 + 1);
    expect(await kitchen.conn.next("notice.cleared")).toEqual({
      t: "notice.cleared",
      id: r.json.id,
    });
    expect((await s.api.request(`/notices/${r.json.id}/audio?token=${token}`)).status).toBe(404);
  });

  it("dismissed on one phone stays dismissed there; taken down leaves every phone", async () => {
    const { mom, kitchen, hall } = await home();
    const r = await post(mom.token, { text: "Kitchen closes\nat 10" });
    await kitchen.conn.next("notice");
    await hall.conn.next("notice");
    kitchen.conn.write({ t: "notice.dismiss", id: r.json.id });
    expect((await kitchen.conn.next("notice.cleared")).id).toBe(r.json.id);
    // Back online: not shown again there.
    const back = await s.connectDevice(kitchen.id, kitchen.key.pair);
    await new Promise((res) => setTimeout(res, 20));
    expect(back.all("notice")).toEqual([]);
    expectStatus(
      await s.http(`/notices/${r.json.id}`, { method: "DELETE", token: mom.token }),
      204,
    );
    expect((await hall.conn.next("notice.cleared")).id).toBe(r.json.id);
    const list = (await s.http("/notices", { token: mom.token })).json;
    expect(list[0]).toMatchObject({
      id: r.json.id,
      live: false,
      lines: ["KITCHEN CLOSES", "AT 10"],
    });
  });

  it("only the phones picked; a newer notice replaces an older one", async () => {
    const { mom, kitchen, hall } = await home();
    expectStatus(await post(mom.token, { text: "Hi", deviceIds: ["dev_notmine12345"] }), 400);
    const r = await post(mom.token, { text: "Hall only", deviceIds: [hall.id] });
    expect((await hall.conn.next("notice")).id).toBe(r.json.id);
    await new Promise((res) => setTimeout(res, 20));
    expect(kitchen.conn.all("notice")).toEqual([]);
    const r2 = await post(mom.token, { text: "Everyone" });
    expect((await hall.conn.next("notice")).id).toBe(r2.json.id);
    expect((await kitchen.conn.next("notice")).id).toBe(r2.json.id);
  });

  it("team spaces: admins post, members don't; Lounge phones show it", async () => {
    const olga = await s.person("olga", "Olga", "team");
    const member = await s.store.createUser(
      { householdId: olga.household.id, name: "Ben", role: "contact" },
      s.timers.now,
    );
    const benToken = await s.store.createSession(member.id, s.timers.now);
    const lobby = await s.pairDevice(olga.token, "Lobby", { kind: "lounge" });
    if (!lobby.deviceId || !lobby.key) throw new Error("pairing failed");
    const phone = await s.connectDevice(lobby.deviceId, lobby.key.pair);
    expectStatus(await post(benToken, { text: "Hi" }), 403);
    const r = await post(olga.token, { text: "Standup now" });
    expect((await phone.next("notice")).id).toBe(r.json.id);
    await s.http(`/notices/${r.json.id}`, { method: "DELETE", token: olga.token });
    // The space's audit trail has both.
    const audit = (await s.http("/space/audit", { token: olga.token })).json as {
      action: string;
    }[];
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["notice.post", "notice.delete"]),
    );
  });
});
