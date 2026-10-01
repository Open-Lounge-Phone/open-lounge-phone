import {
  loadServerKey,
  ROTATION_OVERLAP_S,
  rotationStatement,
  signBytes,
  signRotation,
} from "@openloungephone/federation";
import { beforeEach, describe, expect, it } from "vitest";
import { expectStatus, Network, TestServer } from "./testkit.ts";

const DAY = 24 * 60 * 60 * 1000;

type Person = Awaited<ReturnType<TestServer["person"]>>;

async function knock(s: TestServer, from: Person, to: string, note?: string) {
  return s.http("/connections", { token: from.token, body: { to, ...(note ? { note } : {}) } });
}
async function list(s: TestServer, p: Person) {
  const r = await s.http("/connections", { token: p.token });
  expectStatus(r, 200);
  return r.json as {
    address: string;
    connections: {
      id: string;
      address: string;
      name: string;
      state: string;
      direction: string;
      note: string | null;
      remote: boolean;
    }[];
    blockedServers: { id: string; host: string }[];
  };
}
async function incoming(s: TestServer, p: Person) {
  return (await list(s, p)).connections.filter(
    (c) => c.state === "requested" && c.direction === "in",
  );
}
async function act(s: TestServer, p: Person, id: string, what: "accept" | "decline" | "block") {
  return s.http(`/connections/${id}/${what}`, { method: "POST", token: p.token });
}
/** The response a knocker sees, without ids and timestamps. */
const shape = (r: { status: number; json: { status: string; connection: object } }) => ({
  status: r.status,
  body: {
    status: r.json.status,
    connection: {
      ...r.json.connection,
      id: "",
      createdAt: 0,
      expiresAt: 0,
      address: "",
      host: "",
      name: "",
    },
  },
});

describe("local knocks", () => {
  let s: TestServer;
  let jesse: Person;
  let bob: Person;
  beforeEach(async () => {
    s = new TestServer({ publicUrl: "https://a.test" });
    jesse = await s.person("jesse", "Jesse");
    bob = await s.person("bob", "Bob");
  });

  it("knock, see it with the note, accept: both sides are connected", async () => {
    const bobApp = await s.connectApp(bob.token);
    const sent = await knock(s, jesse, "bob@a.test", "It's Jesse from the band");
    expectStatus(sent, 202);
    expect(sent.json.connection).toMatchObject({ address: "bob@a.test", state: "requested" });
    await bobApp.next("connections.changed");
    const [req] = await incoming(s, bob);
    expect(req).toMatchObject({
      address: "jesse@a.test",
      name: "Jesse",
      note: "It's Jesse from the band",
      remote: false,
    });
    expectStatus(await act(s, bob, req?.id as string, "accept"), 200);
    expect((await list(s, jesse)).connections).toMatchObject([
      { address: "bob@a.test", name: "Bob", state: "active" },
    ]);
    expect((await list(s, bob)).connections).toMatchObject([
      { address: "jesse@a.test", state: "active" },
    ]);
    // A renamed handle shows up in the other person's list.
    await s.http("/account", { method: "PATCH", token: bob.token, body: { handle: "robert" } });
    expect((await list(s, jesse)).connections[0]?.address).toBe("robert@a.test");
    // Disconnecting removes it on both sides.
    const [mine] = (await list(s, jesse)).connections;
    expectStatus(
      await s.http(`/connections/${mine?.id}`, { method: "DELETE", token: jesse.token }),
      204,
    );
    expect((await list(s, bob)).connections).toEqual([]);
  });

  it("knocking back someone who knocked you connects you both", async () => {
    await knock(s, jesse, "bob@a.test");
    const back = await knock(s, bob, "jesse@a.test");
    expectStatus(back, 200);
    expect(back.json.status).toBe("connected");
    expect((await list(s, jesse)).connections[0]?.state).toBe("active");
  });

  it("allows one pending knock per pair and ten a day", async () => {
    expectStatus(await knock(s, jesse, "bob@a.test"), 202);
    expectStatus(await knock(s, jesse, "bob@a.test"), 409);
    for (let i = 0; i < 9; i++) expectStatus(await knock(s, jesse, `nobody${i}@a.test`), 202);
    const eleventh = await knock(s, jesse, "nobody-else@a.test");
    expectStatus(eleventh, 429);
    s.timers.advance(DAY);
    expectStatus(await knock(s, jesse, "nobody-else@a.test"), 202);
  });

  it("expires knocks after 30 days", async () => {
    await knock(s, jesse, "bob@a.test");
    s.timers.advance(30 * DAY + 1);
    const fresh = { ...bob, token: await s.store.createSession(bob.user.id, s.timers.now) };
    const jesseNow = { ...jesse, token: await s.store.createSession(jesse.user.id, s.timers.now) };
    expect(await incoming(s, fresh)).toEqual([]);
    expect((await list(s, jesseNow)).connections).toEqual([]);
    expectStatus(await knock(s, jesseNow, "bob@a.test"), 202);
    expect(await incoming(s, fresh)).toHaveLength(1);
  });

  it("declines silently, and drops re-knocks for 30 days", async () => {
    await knock(s, jesse, "bob@a.test");
    const [req] = await incoming(s, bob);
    expectStatus(await act(s, bob, req?.id as string, "decline"), 204);
    // Jesse isn't told: still "requested" on her side.
    expect((await list(s, jesse)).connections[0]).toMatchObject({ state: "requested" });
    expect(await incoming(s, bob)).toEqual([]);
    // Jesse cancels and knocks again: it looks sent, but never arrives.
    const [mine] = (await list(s, jesse)).connections;
    await s.http(`/connections/${mine?.id}`, { method: "DELETE", token: jesse.token });
    expectStatus(await knock(s, jesse, "bob@a.test"), 202);
    expect(await incoming(s, bob)).toEqual([]);
    s.timers.advance(30 * DAY + 1);
    const b2 = { ...bob, token: await s.store.createSession(bob.user.id, s.timers.now) };
    const j2 = { ...jesse, token: await s.store.createSession(jesse.user.id, s.timers.now) };
    expectStatus(await knock(s, j2, "bob@a.test"), 202);
    expect(await incoming(s, b2)).toHaveLength(1);
  });

  it("blocks a person for good; a block of an active connection removes it on their side", async () => {
    await knock(s, jesse, "bob@a.test");
    const [req] = await incoming(s, bob);
    await act(s, bob, req?.id as string, "accept");
    const [bobsRow] = (await list(s, bob)).connections;
    expectStatus(await act(s, bob, bobsRow?.id as string, "block"), 204);
    expect((await list(s, jesse)).connections).toEqual([]);
    expectStatus(await knock(s, jesse, "bob@a.test"), 202);
    s.timers.advance(40 * DAY);
    const j2 = { ...jesse, token: await s.store.createSession(jesse.user.id, s.timers.now) };
    const b2 = { ...bob, token: await s.store.createSession(bob.user.id, s.timers.now) };
    await knock(s, j2, "bob@a.test");
    expect(await incoming(s, b2)).toEqual([]);
    // Bob can unblock by removing the row.
    await s.http(`/connections/${bobsRow?.id}`, { method: "DELETE", token: b2.token });
    const j3 = { ...j2 };
    const cancel = (await list(s, j3)).connections[0];
    await s.http(`/connections/${cancel?.id}`, { method: "DELETE", token: j3.token });
    await knock(s, j3, "bob@a.test");
    expect(await incoming(s, b2)).toHaveLength(1);
  });

  it("answers the same for unknown handles, blocked senders and real people", async () => {
    const eve = await s.person("eve");
    const real = await knock(s, eve, "bob@a.test");
    const unknown = await knock(s, eve, "nosuchperson@a.test");
    const [req] = await incoming(s, bob);
    await act(s, bob, req?.id as string, "block");
    const [c] = (await list(s, eve)).connections.filter((x) => x.address === "bob@a.test");
    await s.http(`/connections/${c?.id}`, { method: "DELETE", token: eve.token });
    const blocked = await knock(s, eve, "bob@a.test");
    expect(shape(unknown)).toEqual(shape(real));
    expect(shape(blocked)).toEqual(shape(real));
  });

  it("never reaches kids' phones: only accounts have addresses", async () => {
    const kid = await s.pairDevice(bob.token, "Kid phone");
    const deviceId = kid.deviceId as string;
    expectStatus(await knock(s, jesse, `${deviceId.toLowerCase()}@a.test`), 202);
    expectStatus(await knock(s, jesse, "kid.phone@a.test"), 202);
    expect(await incoming(s, bob)).toEqual([]);
    const rows = await s.store.connections.list(bob.account.id);
    expect(rows).toEqual([]);
  });

  it("keeps connections to their owner", async () => {
    await knock(s, jesse, "bob@a.test");
    const [req] = await incoming(s, bob);
    const eve = await s.person("eve");
    expectStatus(await act(s, eve, req?.id as string, "accept"), 404);
    expectStatus(
      await s.http(`/connections/${req?.id}`, { method: "DELETE", token: eve.token }),
      404,
    );
    expect(await incoming(s, bob)).toHaveLength(1);
  });

  it("puts only your own active connections on a kid's allow-list, and removes them with it", async () => {
    const kid = await s.pairDevice(bob.token, "Kid phone");
    const deviceId = kid.deviceId as string;
    const phone = await s.connectDevice(deviceId, kid.key?.pair as CryptoKeyPair);
    await knock(s, jesse, "bob@a.test");
    const [req] = await incoming(s, bob);
    const flags = {
      label: "Jesse",
      canCallDevice: true,
      deviceCanCall: true,
      bypassQuietHours: false,
    };
    const add = (who: Person, connectionId: string) =>
      s.http(`/devices/${deviceId}/remote-contacts/${connectionId}`, {
        method: "PUT",
        token: who.token,
        body: flags,
      });
    expectStatus(await add(bob, req?.id as string), 409); // not accepted yet
    await act(s, bob, req?.id as string, "accept");
    const [jessesRow] = (await list(s, jesse)).connections;
    expectStatus(await add(bob, jessesRow?.id as string), 404); // someone else's connection
    const added = await add(bob, req?.id as string);
    expectStatus(added, 200);
    const rc = added.json.id as string;
    expect(rc).toMatch(/^rc_/);
    const contacts = await s.http(`/devices/${deviceId}/contacts`, { token: bob.token });
    expect(contacts.json.remote).toEqual([
      { id: rc, connectionId: req?.id, address: "jesse@a.test", name: "Jesse" },
    ]);
    expectStatus(
      await s.http(`/devices/${deviceId}/buttons/1`, {
        method: "PUT",
        token: bob.token,
        body: { userId: rc },
      }),
      204,
    );
    const config = phone.all("config").at(-1);
    expect(config?.buttons).toEqual([
      { index: 0, label: "Bob" },
      { index: 1, label: "Jesse" },
    ]);
    // Jesse disconnects: the entry and its key are gone.
    await s.http(`/connections/${jessesRow?.id}`, { method: "DELETE", token: jesse.token });
    expect(await s.store.listRemoteContacts(deviceId)).toEqual([]);
    expect([...(await s.store.listButtons(deviceId)).keys()]).toEqual([0]);
  });
});

describe("knocks across servers", () => {
  let net: Network;
  let a: TestServer;
  let b: TestServer;
  let jesse: Person;
  let bob: Person;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test");
    b = await net.server("b.test");
    jesse = await a.person("jesse", "Jesse");
    bob = await b.person("bob", "Bob");
  });

  it("publishes a key, knocks with a signed request, accepts, and disconnects", async () => {
    const wk = await b.root.request("/.well-known/openloungephone");
    expect(await wk.json()).toMatchObject({ version: 1, federation: "/fed/v1" });
    expectStatus(await knock(a, jesse, "bob@b.test", "hi"), 202);
    const [req] = await incoming(b, bob);
    expect(req).toMatchObject({ address: "jesse@a.test", name: "Jesse", remote: true, note: "hi" });
    expectStatus(await act(b, bob, req?.id as string, "accept"), 200);
    expect((await list(a, jesse)).connections).toMatchObject([
      { address: "bob@b.test", name: "Bob", state: "active", remote: true },
    ]);
    // Each side pinned the other's key on first contact.
    expect(await a.store.connections.pinnedKey("b.test")).toBeDefined();
    expect(await b.store.connections.pinnedKey("a.test")).toBeDefined();
    const [row] = (await list(a, jesse)).connections;
    await a.http(`/connections/${row?.id}`, { method: "DELETE", token: jesse.token });
    expect((await list(b, bob)).connections).toEqual([]);
  });

  it("only the knocked person's server can accept, for a knock that was sent", async () => {
    // b.test claims Bob accepted a knock Jesse never sent: ignored.
    const svc = await import("./connections.ts");
    await new svc.Connections(a.env, a.gateway).receiveAccept(
      { host: "b.test", handle: "bob", id: bob.account.id, name: "Bob" },
      "jesse",
    );
    expect((await list(a, jesse)).connections).toEqual([]);
    // Nor can it turn Bob's own pending knock, or Jesse's block, into a connection.
    const svcA = new svc.Connections(a.env, a.gateway);
    const bobParty = { host: "b.test", handle: "bob", id: bob.account.id, name: "Bob" };
    await knock(b, bob, "jesse@a.test");
    await svcA.receiveAccept(bobParty, "jesse");
    expect((await list(a, jesse)).connections).toMatchObject([
      { state: "requested", direction: "in" },
    ]);
    const [req] = await incoming(a, jesse);
    await act(a, jesse, req?.id as string, "block");
    await svcA.receiveAccept(bobParty, "jesse");
    expect((await list(a, jesse)).connections).toMatchObject([{ state: "blocked" }]);
  });

  it("answers every knock the same, so handles can't be enumerated", async () => {
    await knock(a, jesse, "bob@b.test");
    await knock(a, jesse, "ghost@b.test");
    const eve = await a.person("eve");
    const [req] = await incoming(b, bob);
    await act(b, bob, req?.id as string, "block");
    await knock(a, eve, "bob@b.test"); // not blocked (a different person)
    // Blocking is silent too: Jesse's knock still looks pending; she cancels and tries again.
    const [row] = (await list(a, jesse)).connections.filter((c) => c.address === "bob@b.test");
    expect(row?.state).toBe("requested");
    await a.http(`/connections/${row?.id}`, { method: "DELETE", token: jesse.token });
    await knock(a, jesse, "bob@b.test"); // blocked sender
    const knocks = net.requests.filter((r) => r.url.endsWith("/fed/v1/knock"));
    expect(knocks.map((k) => k.status)).toEqual([202, 202, 202, 202]);
    expect((await incoming(b, bob)).map((c) => c.address)).toEqual(["eve@a.test"]);
  });

  it("blocks a whole server for one person, and the operator blocks it for everyone", async () => {
    const [bobBlocks] = [
      await b.http("/connections/block-server", { token: bob.token, body: { host: "a.test" } }),
    ];
    expectStatus(bobBlocks, 204);
    await knock(a, jesse, "bob@b.test");
    expect(await incoming(b, bob)).toEqual([]);
    const carol = await b.person("carol");
    await knock(a, jesse, "carol@b.test");
    expect(await incoming(b, carol)).toHaveLength(1);
    // Operator block: every request from a.test is refused, and b.test won't send to it.
    await b.store.connections.blockServer("a.test", "spam", b.timers.now);
    const refused = await knock(a, jesse, "dave@b.test");
    expectStatus(refused, 502);
    expect(net.requests.at(-1)?.status).toBe(403);
    expectStatus(await knock(b, carol, "jesse@a.test"), 403);
  });

  it("rejects replayed, stale and tampered requests", async () => {
    let captured: Request | undefined;
    net.tap = (req) => {
      // The knock itself (not a's look at b's .well-known before it).
      if (req.method === "POST") captured ??= req.clone();
      return req;
    };
    await knock(a, jesse, "bob@b.test");
    net.tap = undefined;
    const replay = await b.root.fetch(captured?.clone() as Request);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "signature: replay" });

    // Stale: delivered 6 minutes after it was signed.
    net.tap = (req) => {
      net.timers.now += 6 * 60_000;
      return req;
    };
    const stale = await knock(a, jesse, "carol@b.test");
    expectStatus(stale, 502);
    expect(net.requests.at(-1)?.status).toBe(401);

    // Tampered: the body is swapped for someone else's name.
    net.tap = async (req) => {
      const body = JSON.parse(await req.text());
      body.from.name = "The Bank";
      return new Request(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(body),
      });
    };
    expectStatus(await knock(a, jesse, "dan@b.test"), 502);
    expect(net.requests.at(-1)?.status).toBe(401);
    net.tap = undefined;
    expect(await incoming(b, bob)).toHaveLength(1);
  });

  it("refuses a changed server key unless the old key signed the rotation", async () => {
    await knock(a, jesse, "bob@b.test"); // b pins a's key
    const oldKey = a.env.federationKey as string;
    // a.test's key is replaced (e.g. someone else took over the name).
    const impostor = await net.server("a.test");
    const mallory = await impostor.person("jesse", "Jesse");
    const [before] = await incoming(b, bob);
    await b.http(`/connections/${before?.id}`, { method: "DELETE", token: bob.token });
    expectStatus(await knock(impostor, mallory, "bob@b.test"), 502);
    expect(net.requests.at(-1)?.status).toBe(401);
    expect(await b.store.connections.keyAlerts()).toMatchObject([{ host: "a.test" }]);
    expect(await incoming(b, bob)).toEqual([]);

    // A hand-over in the 0.1 form (no time) isn't enough any more; a timed one is.
    const next = await loadServerKey(impostor.env.federationKey as string);
    const old = await loadServerKey(oldKey);
    const legacy = {
      version: 1,
      server_key: next.publicKey,
      federation: "/fed/v1",
      previous_key: old.publicKey,
      rotation_sig: await signBytes(old, rotationStatement(next.publicKey)),
    };
    let doc: object = legacy;
    const original = net.fetch.bind(net);
    net.fetch = async (req) =>
      req.url === "https://a.test/.well-known/openloungephone" ? Response.json(doc) : original(req);
    expectStatus(await knock(impostor, mallory, "bob@b.test"), 502);
    expect(await b.store.connections.pinnedKey("a.test")).toBe(old.publicKey);
    const created = Math.floor(net.timers.now / 1000);
    doc = {
      ...legacy,
      rotation: await signRotation(old, next.publicKey, "a.test", created, ROTATION_OVERLAP_S),
    };
    expectStatus(await knock(impostor, mallory, "bob@b.test"), 202);
    expect(await incoming(b, bob)).toHaveLength(1);
    expect(await b.store.connections.pinnedKey("a.test")).toBe(next.publicKey);
    // Following the rotation cleared the refused change.
    expect(await b.store.connections.keyAlerts()).toEqual([]);
  });

  it("limits each remote server's request rate", async () => {
    b.env.limits = { fedRequestsPerMinute: 3 };
    for (const who of ["c1", "c2", "c3"]) expectStatus(await knock(a, jesse, `${who}@b.test`), 202);
    const over = await knock(a, jesse, "c4@b.test");
    expectStatus(over, 429);
    net.timers.advance(60_000);
    expectStatus(await knock(a, jesse, "c4@b.test"), 202);
  });

  it("never contacts its own network: loopback names, IP literals, local names", async () => {
    // Servers that exist on the test network under such names, to prove nothing is sent there.
    const inside = await net.server("127.0.0.1");
    await inside.person("admin", "Admin");
    for (const to of ["admin@127.0.0.1", "admin@localhost:6379", "x@printer.local"]) {
      expectStatus(await knock(a, jesse, to), 400);
    }
    expect(net.requests.filter((r) => !r.url.includes("b.test"))).toEqual([]);
    // A request whose keyid names a loopback host: its key is never fetched.
    const dev = await net.server("localhost:9");
    const mallory = await dev.person("mallory", "Mallory");
    expectStatus(await knock(dev, mallory, "bob@b.test"), 502);
    expect(net.requests.some((r) => r.url.startsWith("http://localhost:9/"))).toBe(false);
    expect(net.requests.find((r) => r.url.endsWith("/fed/v1/knock"))?.status).toBe(401);
  });

  it("surfaces an unreachable server and keeps nothing half-done", async () => {
    net.down.add("b.test");
    expectStatus(await knock(a, jesse, "bob@b.test"), 502);
    expect((await list(a, jesse)).connections).toEqual([]);
  });
});
