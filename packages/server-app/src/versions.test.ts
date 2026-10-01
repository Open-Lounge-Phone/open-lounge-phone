// Versions and features between servers (spec §9): what this server advertises, how it
// negotiates with older, newer and partial peers, and how it degrades in plain words.
import { readFileSync } from "node:fs";
import { FEATURE_NAMES, type Party } from "@openloungephone/federation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FederationError, fedFetch } from "./federation.ts";
import { peerSupports, UNAVAILABLE } from "./peers.ts";
import { expectStatus, Network, type TestServer } from "./testkit.ts";
import { SERVER_VERSION, SOFTWARE } from "./version.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { version: string };

/** `a` knocks on `b`, `b` accepts; returns `a`'s connection id. */
async function connect(sa: TestServer, a: Person, sb: TestServer, b: Person) {
  expectStatus(await sa.http("/connections", { token: a.token, body: { to: b.address } }), 202);
  const inbox = await sb.http("/connections", { token: b.token });
  const req = inbox.json.connections.find((c: { address: string }) => c.address === a.address);
  expectStatus(
    await sb.http(`/connections/${req.id}/accept`, { method: "POST", token: b.token }),
    200,
  );
  return (await sa.http("/connections", { token: a.token })).json.connections.find(
    (c: { address: string }) => c.address === b.address,
  ).id as string;
}

const party = (p: Person): Party => ({ handle: p.account.handle, id: p.account.id, name: "x" });
const wellKnownFetches = (net: Network, host: string) =>
  net.requests.filter((r) => r.url === `https://${host}/.well-known/openloungephone`).length;
const posts = (net: Network, path: string) =>
  net.requests.filter((r) => new URL(r.url).pathname === path).length;
/** Captures a server's log lines. */
function logOf(s: TestServer) {
  const lines: { level: string; msg: string; data?: unknown }[] = [];
  s.env.log = (level, msg, data) => void lines.push({ level, msg, data });
  return lines;
}

describe("what this server advertises", () => {
  it("its software is the package version; .well-known lists versions and features", async () => {
    expect(SERVER_VERSION).toBe(rootPackage.version);
    const net = new Network();
    const a = await net.server("a.test");
    const res = await a.root.fetch(new Request("https://a.test/.well-known/openloungephone"));
    const doc = await res.json();
    expect(doc).toEqual({
      version: 1,
      server_key: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      federation: "/fed/v1",
      software: `openloungephone/${rootPackage.version}`,
      versions: { "1": "/fed/v1" },
      features: FEATURE_NAMES,
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await a.http("/health")).json.software).toBe(SOFTWARE);
  });
});

describe("negotiating with other servers", () => {
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

  it("caches a peer's .well-known for its max-age; looks again after it and after an error", async () => {
    const knock = (to: string) =>
      a.http("/connections", { token: jesse.token, body: { to: `${to}@b.test` } });
    await b.person("cy");
    await b.person("dee");
    expectStatus(await knock("bob"), 202);
    expect(wellKnownFetches(net, "b.test")).toBe(1);
    net.timers.advance(299_000);
    expectStatus(await knock("cy"), 202);
    expect(wellKnownFetches(net, "b.test")).toBe(1);
    net.timers.advance(2_000);
    expectStatus(await knock("dee"), 202);
    expect(wellKnownFetches(net, "b.test")).toBe(2);
    // An endpoint b doesn't have: plain "not supported", and b is looked at again next time.
    const missing = await fedFetch(a.env, "b.test", "/video/start", { json: {} }).catch((e) => e);
    expect(missing).toBeInstanceOf(FederationError);
    expect(missing).toMatchObject({
      code: "not_supported",
      message: "b.test doesn't support this yet",
    });
    expect(await peerSupports(a.env, "b.test", "rooms")).toBe(true);
    expect(wellKnownFetches(net, "b.test")).toBe(3);
  });

  it("an 0.1 server (no versions, no features) gets everything it did before", async () => {
    await net.advertise("b.test", (d) => ({
      version: 1,
      server_key: d.server_key,
      federation: "/fed/v1",
      software: "openloungephone/0.1",
    }));
    for (const f of FEATURE_NAMES) expect(await peerSupports(a.env, "b.test", f)).toBe(true);
    const connId = await connect(a, jesse, b, bob);
    const jApp = await a.connectApp(jesse.token);
    const bApp = await b.connectApp(bob.token);
    jApp.write({ t: "call.connection", connectionId: connId });
    expect((await bApp.next("call.ringing")).from.label).toBe("Jesse");
  });

  it("uses a feature only with a server that lists it, and says so plainly otherwise", async () => {
    await connect(a, jesse, b, bob);
    await net.advertise("b.test", (d) => ({ ...d, features: [] }));
    const calls = a.env.calls;
    if (!calls) throw new Error("no calls");
    // Rooms: refused here, nothing sent.
    const join = await calls.roomJoin(
      "b.test",
      { leg: "leg1", from: party(jesse), room: "standup" },
      jesse.household.id,
    );
    expect(join).toEqual({ ok: false, reason: "unreachable", note: UNAVAILABLE.rooms });
    expect(join.ok === false && join.note).toBe("Rooms aren't available with that server yet");
    expect(posts(net, "/fed/v1/rooms/join")).toBe(0);
    // A recorded call is never placed with a server that can't announce it.
    const recorded = await calls.place(
      "b.test",
      {
        callId: "call_rec",
        from: party(jesse),
        to: { kind: "person", handle: "bob" },
        recording: true,
      },
      jesse.household.id,
    );
    expect(recorded).toEqual({
      state: "ended",
      reason: "denied",
      note: UNAVAILABLE["recording-flag"],
    });
    expect(posts(net, "/fed/v1/calls")).toBe(0);
    // An unrecorded call still goes through: the core of v1 isn't a feature.
    await b.connectApp(bob.token);
    const plain = await calls.place(
      "b.test",
      { callId: "call_plain", from: party(jesse), to: { kind: "person", handle: "bob" } },
      jesse.household.id,
    );
    expect(plain).toEqual({ state: "ringing" });
    // Lounge guests: the companion is told before anything is sent.
    const claim = await a.http("/lounge/remote", {
      token: jesse.token,
      body: { host: "b.test", deviceId: "dev_x", nonce: "n".repeat(22) },
    });
    expectStatus(claim, 409);
    expect(claim.json.error).toBe("Lounge guests aren't available with that server yet");
    expect(posts(net, "/fed/v1/lounge/claim")).toBe(0);
    // Availability isn't sent to a server that doesn't take it batched.
    expectStatus(
      await a.http("/account", {
        method: "PATCH",
        token: jesse.token,
        body: { sharePresence: true },
      }),
      200,
    );
    await a.connectApp(jesse.token);
    await Promise.all(a.background);
    expect(posts(net, "/fed/v1/presence")).toBe(0);
  });

  it("with no common version: a clear error both ways, logged, and nothing crashes", async () => {
    await connect(a, jesse, b, bob);
    await net.advertise("b.test", (d) => ({ ...d, version: 2, versions: { "2": "/fed/v2" } }));
    const log = logOf(a);
    const sentBefore = net.requests.length;
    const knock = await a.http("/connections", {
      token: jesse.token,
      body: { to: "cy@b.test" },
    });
    expectStatus(knock, 502);
    expect(knock.json.error).toBe(
      "b.test only speaks a newer federation version (2); this server needs an update to talk to it",
    );
    expect(log).toContainEqual({
      level: "warn",
      msg: "federation: no common version",
      data: { host: "b.test", ours: [1], theirs: [2] },
    });
    // A call ends with the same words for the caller.
    const call = await a.env.calls?.place(
      "b.test",
      { callId: "call_v", from: party(jesse), to: { kind: "person", handle: "bob" } },
      jesse.household.id,
    );
    expect(call).toMatchObject({ state: "ended", reason: "unreachable" });
    expect(call?.state === "ended" && call.note).toMatch(/newer federation version/);
    // Only b's .well-known was fetched: nothing was sent to a path b doesn't serve.
    expect(
      net.requests.slice(sentBefore).filter((r) => new URL(r.url).pathname.startsWith("/fed/")),
    ).toEqual([]);
    // The other way: a request for a version this server doesn't speak, and an unknown endpoint.
    const v2 = await a.root.fetch(
      new Request("https://a.test/fed/v2/knock", { method: "POST", body: "{}" }),
    );
    expect(v2.status).toBe(404);
    expect(await v2.json()).toEqual({
      error: "federation version 2 isn't supported here; this server speaks 1",
    });
    const unknown = await a.root.fetch(
      new Request("https://a.test/fed/v1/video/start", { method: "POST", body: "{}" }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not supported" });
  });
});

describe("a newer server", () => {
  let net: Network;
  let a: TestServer;
  let future: TestServer;
  let jesse: Person;
  let zed: Person;
  beforeEach(async () => {
    net = new Network();
    a = await net.server("a.test");
    future = await net.server("future.test");
    // It speaks versions 1–3, lists features this server has never heard of, and adds fields.
    await net.advertise("future.test", (d) => ({
      ...d,
      version: 3,
      software: "openloungephone/9.0.0",
      versions: { "1": "/fed/v1", "2": "/fed/v2", "3": "/fed/v3" },
      features: [...(d.features as string[]), "video", "holograms"],
      motd: "hello from the future",
      policy: { retention: "30d" },
    }));
    jesse = await a.person("jesse", "Jesse");
    zed = await future.person("zed", "Zed");
  });

  it("is spoken to in the highest common version (1) and its unknown fields are ignored", async () => {
    const connId = await connect(a, jesse, future, zed);
    expect(net.requests.some((r) => r.url === "https://future.test/fed/v1/knock")).toBe(true);
    expect(net.requests.some((r) => r.url.includes("/fed/v2") || r.url.includes("/fed/v3"))).toBe(
      false,
    );
    expect(await peerSupports(a.env, "future.test", "rooms")).toBe(true);
    // Its requests carry fields this server doesn't know: accepted, the fields dropped.
    const sam = await future.person("sam", "Sam");
    const knock = await fedFetch(future.env, "a.test", "/knock", {
      json: {
        from: { ...party(sam), name: "Sam", avatar: "https://future.test/sam.png" },
        to: "jesse",
        note: "hi from the future",
        priority: 5,
        video: { codecs: ["av1"] },
      },
    });
    expect(knock.status).toBe(202);
    const inbox = (await a.http("/connections", { token: jesse.token })).json.connections;
    expect(inbox).toContainEqual(
      expect.objectContaining({ address: "sam@future.test", note: "hi from the future" }),
    );
    // A call from it with extra fields rings; a call to it goes over the v1 stream.
    const jApp = await a.connectApp(jesse.token);
    const zApp = await future.connectApp(zed.token);
    zApp.write({
      t: "call.connection",
      connectionId: (await future.http("/connections", { token: zed.token })).json.connections[0]
        .id,
    });
    const ring = await jApp.next("call.ringing");
    expect(ring.from.label).toBe("Zed");
    const callId = ring.callId;
    jApp.write({ t: "call.answer", callId });
    await zApp.nextState("connecting");
    // The stream: a signal type this server doesn't know is answered "unsupported" (logged on
    // the sender), and a known signal with extra fields is delivered without them.
    const futureLog = logOf(future);
    await future.links.signal("a.test", { t: "call.video", callId, on: true } as never);
    await vi.waitFor(() =>
      expect(futureLog).toContainEqual({
        level: "warn",
        msg: "stream: the other server doesn't support a frame we sent",
        data: { host: "a.test", type: "signal:call.video" },
      }),
    );
    await future.links.signal("a.test", {
      t: "rtc.ice",
      callId,
      candidate: "candidate:9",
      sdpMid: "0",
      sdpMLineIndex: 0,
      priority: 7,
    } as never);
    const ice = await jApp.next("rtc.ice");
    expect(ice).toEqual({
      t: "rtc.ice",
      callId,
      candidate: "candidate:9",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    // The call goes on: hang up from this side reaches the newer server.
    jApp.write({ t: "call.hangup", callId });
    expect(await zApp.nextState("ended")).toMatchObject({ reason: "hangup" });
    expect(connId).toBeTruthy();
  });

  it("can't make this server use a version it doesn't speak, whatever it advertises", async () => {
    await net.advertise("future.test", (d) => ({ ...d, versions: { "1": "/../api/x" } }));
    // An unusable base path counts as no version 1 at all.
    const knock = await a.http("/connections", {
      token: jesse.token,
      body: { to: "zed@future.test" },
    });
    expectStatus(knock, 502);
    expect(knock.json.error).toBe(
      "future.test doesn't offer a federation version this server can use",
    );
    expect(net.requests.some((r) => r.url.includes("/api/x"))).toBe(false);
  });
});
