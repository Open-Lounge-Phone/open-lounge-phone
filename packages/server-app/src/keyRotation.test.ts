// Rotating this server's federation key, peers following it, and the operator's view of pinned
// keys (docs/federation-spec.md §3).
import {
  keyFingerprint,
  loadServerKey,
  publicKeyOf,
  ROTATION_OVERLAP_S,
  WellKnown,
} from "@openloungephone/federation";
import { beforeEach, describe, expect, it } from "vitest";
import { dbKeyStore, ownKeys } from "./ownKey.ts";
import { expectStatus, Network, type TestServer } from "./testkit.ts";

type Person = Awaited<ReturnType<TestServer["person"]>>;

const knock = (s: TestServer, from: Person, to: string) =>
  s.http("/connections", { token: from.token, body: { to } });
async function wellKnown(s: TestServer) {
  const res = await s.root.fetch(new Request(`https://${s.host}/.well-known/openloungephone`));
  return WellKnown.parse(await res.json());
}
const fedView = async (s: TestServer, p: Person) => {
  const r = await s.http("/admin/federation", { token: p.token });
  expectStatus(r, 200);
  return r.json as {
    own: {
      fingerprint: string;
      rotation: { previousFingerprint: string; expiresAt: number } | null;
    } | null;
    peers: {
      host: string;
      fingerprint: string;
      firstSeen: number;
      keySince: number;
      status: "pinned" | "rejected_change";
      rejected: { fingerprint: string; at: number } | null;
      blocked: boolean;
    }[];
  };
};
const audit = async (s: TestServer, p: Person) =>
  (await s.http("/admin/audit", { token: p.token })).json as {
    action: string;
    actorAccount: string | null;
    detail: Record<string, unknown>;
  }[];
const rotate = (s: TestServer, p: Person, force?: boolean) =>
  s.http("/admin/federation/rotate-key", { token: p.token, body: force ? { force } : {} });

let net: Network;
let a: TestServer;
let b: TestServer;
let opA: Person;
let opB: Person;
let jesse: Person;

beforeEach(async () => {
  net = new Network();
  a = await net.server("a.test", { env: { operators: ["root"] } });
  b = await net.server("b.test", { env: { operators: ["root"] } });
  opA = await a.person("root", "Ada");
  opB = await b.person("root", "Bo");
  jesse = await a.person("jesse", "Jesse");
  for (const h of ["bob", "dan", "eve"]) await b.person(h);
  expectStatus(await knock(a, jesse, "bob@b.test"), 202); // b pins a's key
});

describe("rotating this server's key", () => {
  it("tells the operator which peers can't follow by themselves (no `key-rotation`)", async () => {
    // a knocked on b, so a knows what b advertises.
    expect((await rotate(a, opA)).json.cannotFollow).toBeUndefined();
    await net.advertise("b.test", (d) => ({
      ...d,
      features: (d.features as string[]).filter((f) => f !== "key-rotation"),
    }));
    expectStatus(await knock(a, jesse, "dan@b.test"), 202);
    const r = await rotate(a, opA, true);
    expectStatus(r, 200);
    expect(r.json.cannotFollow).toEqual(["b.test"]);
    // b's operator sees what a advertises; a's sees b without it.
    const view = (await a.http("/admin/federation", { token: opA.token })).json;
    expect(view.peers).toEqual([]);
    const bView = (await b.http("/admin/federation", { token: opB.token })).json;
    expect(bView.peers[0]).toMatchObject({
      host: "a.test",
      software: expect.stringMatching(/^openloungephone\//),
      versions: [1],
      missing: [],
    });
  });

  it("publishes both keys with a signed hand-over, signs with the new key, and peers follow", async () => {
    const before = await wellKnown(a);
    expect(before.rotation).toBeUndefined();
    const r = await rotate(a, opA);
    expectStatus(r, 200);
    const after = await wellKnown(a);
    expect(after.server_key).not.toBe(before.server_key);
    expect(after).toMatchObject({
      previous_key: before.server_key,
      rotation: {
        previous_key: before.server_key,
        expires: (after.rotation?.created ?? 0) + ROTATION_OVERLAP_S,
      },
    });
    expect(r.json).toEqual({
      from: await keyFingerprint(before.server_key),
      to: await keyFingerprint(after.server_key),
      overlapUntil: (after.rotation?.expires ?? 0) * 1000,
    });
    // The very next request is signed with the new key; b verifies the hand-over and re-pins.
    expectStatus(await knock(a, jesse, "dan@b.test"), 202);
    const signed = net.requests.at(-1);
    expect(signed).toMatchObject({ from: "a.test", status: 202 });
    expect(await b.store.connections.pinnedKey("a.test")).toBe(after.server_key);
    const [peer] = (await fedView(b, opB)).peers;
    expect(peer).toMatchObject({
      host: "a.test",
      fingerprint: await keyFingerprint(after.server_key),
      status: "pinned",
      rejected: null,
    });
    expect(peer?.keySince).toBeGreaterThanOrEqual(peer?.firstSeen ?? 0);
    // Both sides' audit trails say what happened, and who did it.
    expect(await audit(a, opA)).toMatchObject([
      { action: "fedkey.rotate", actorAccount: opA.account.id, detail: r.json },
    ]);
    expect(await audit(b, opB)).toMatchObject([
      {
        action: "fedkey.rotated",
        actorAccount: null,
        detail: { host: "a.test", from: r.json.from, to: r.json.to },
      },
    ]);
    // The operator view shows the rotation in progress.
    expect((await fedView(a, opA)).own).toMatchObject({
      fingerprint: r.json.to,
      rotation: { previousFingerprint: r.json.from },
    });
  });

  it("refuses a second rotation during the overlap unless forced", async () => {
    expectStatus(await rotate(a, opA), 200);
    const again = await rotate(a, opA);
    expectStatus(again, 409);
    expect(again.json.until).toBeGreaterThan(net.timers.now);
    expectStatus(await rotate(a, opA, true), 200);
    expect((await audit(a, opA)).map((e) => e.detail.forced ?? false)).toEqual([true, false]);
  });

  it("stops publishing the hand-over when the overlap ends; late peers need their operator", async () => {
    const old = (await wellKnown(a)).server_key;
    expectStatus(await rotate(a, opA), 200);
    const fresh = (await wellKnown(a)).server_key;
    net.timers.advance(ROTATION_OVERLAP_S * 1000 + 1000);
    const doc = await wellKnown(a);
    expect(doc).toEqual({
      version: 1,
      server_key: fresh,
      federation: "/fed/v1",
      software: expect.any(String),
      versions: { "1": "/fed/v1" },
      features: expect.any(Array),
    });
    // b last saw the old key and missed the whole overlap: the change is refused.
    expectStatus(await knock(a, jesse, "dan@b.test"), 502);
    expect(net.requests.at(-1)?.status).toBe(401);
    expect(await b.store.connections.pinnedKey("a.test")).toBe(old);
    const view = await fedView(b, opB);
    expect(view.peers).toMatchObject([
      {
        host: "a.test",
        status: "rejected_change",
        fingerprint: await keyFingerprint(old),
        rejected: { fingerprint: await keyFingerprint(fresh) },
      },
    ]);
    // Refusals are recorded once per key, not per request.
    expectStatus(await knock(a, jesse, "eve@b.test"), 502);
    expect((await audit(b, opB)).filter((e) => e.action === "fedkey.refused")).toMatchObject([
      { actorAccount: null, detail: { host: "a.test", reason: "none" } },
    ]);
  });
});

describe("refused key changes and re-trust", () => {
  /** a's key is replaced without any hand-over (a lost key, or someone else took the name). */
  async function replaceKeyWithoutStatement(
    tamper?: (doc: Record<string, unknown>) => void,
  ): Promise<{ old: string; fresh: string }> {
    const old = (await wellKnown(a)).server_key;
    expectStatus(await rotate(a, opA), 200);
    const fresh = (await wellKnown(a)).server_key;
    const original = net.fetch.bind(net);
    net.fetch = async (req) => {
      const res = await original(req);
      if (!req.url.endsWith("/.well-known/openloungephone")) return res;
      const doc = (await res.json()) as Record<string, unknown>;
      if (tamper) tamper(doc);
      else for (const k of ["rotation", "previous_key", "rotation_sig"]) delete doc[k];
      return Response.json(doc);
    };
    return { old, fresh };
  }

  it("refuses a new key with no statement", async () => {
    await replaceKeyWithoutStatement();
    expectStatus(await knock(a, jesse, "dan@b.test"), 502);
    expect((await fedView(b, opB)).peers[0]?.status).toBe("rejected_change");
  });

  it("refuses a new key whose statement doesn't verify", async () => {
    await replaceKeyWithoutStatement((doc) => {
      const r = doc.rotation as { sig: string };
      r.sig = `${r.sig.startsWith("A") ? "B" : "A"}${r.sig.slice(1)}`;
    });
    expectStatus(await knock(a, jesse, "dan@b.test"), 502);
    expect(await audit(b, opB)).toMatchObject([
      { action: "fedkey.refused", detail: { host: "a.test", reason: "bad_signature" } },
    ]);
  });

  it("re-trusts a refused change only with both fingerprints the operator saw", async () => {
    const { old, fresh } = await replaceKeyWithoutStatement();
    expectStatus(await knock(a, jesse, "dan@b.test"), 502);
    const [from, to] = [await keyFingerprint(old), await keyFingerprint(fresh)];
    const retrust = (body: object, who = opB) =>
      b.http("/admin/federation/peers/a.test/retrust", { token: who.token, body });
    expectStatus(await retrust({ from: to, to: from }), 409);
    expectStatus(await retrust({ from }), 400);
    expect(await b.store.connections.pinnedKey("a.test")).toBe(old);
    expectStatus(await retrust({ from, to }), 204);
    expect(await b.store.connections.pinnedKey("a.test")).toBe(fresh);
    const [peer] = (await fedView(b, opB)).peers;
    expect(peer).toMatchObject({ status: "pinned", fingerprint: to, rejected: null });
    // Nothing left to re-trust, and requests from a go through again.
    expectStatus(await retrust({ from, to }), 404);
    expectStatus(await knock(a, jesse, "dan@b.test"), 202);
    expect((await audit(b, opB)).map((e) => e.action)).toEqual([
      "fedkey.retrust",
      "fedkey.refused",
    ]);
    expect((await audit(b, opB))[0]).toMatchObject({
      actorAccount: opB.account.id,
      detail: { host: "a.test", from, to },
    });
  });

  it("lists whether a pinned server is blocked, and blocking it is audited", async () => {
    expectStatus(
      await b.http("/admin/servers/block", { token: opB.token, body: { host: "a.test" } }),
      204,
    );
    expect((await fedView(b, opB)).peers).toMatchObject([{ host: "a.test", blocked: true }]);
    expectStatus(
      await b.http("/admin/servers/a.test", { method: "DELETE", token: opB.token }),
      204,
    );
    expect((await audit(b, opB)).map((e) => [e.action, e.detail])).toEqual([
      ["server.unblock", { host: "a.test" }],
      ["server.block", { host: "a.test" }],
    ]);
  });
});

describe("operators only", () => {
  it("refuses every key and audit action to anyone else, and changes nothing", async () => {
    const eve = await a.person("mallory", "Mallory");
    const key = (await wellKnown(a)).server_key;
    const fp = await keyFingerprint(key);
    const calls: [string, object?][] = [
      ["/admin/federation"],
      ["/admin/audit"],
      ["/admin/federation/rotate-key", {}],
      ["/admin/federation/rotate-key", { force: true }],
      ["/admin/federation/peers/b.test/retrust", { from: fp, to: fp }],
    ];
    for (const [path, body] of calls) {
      const res = await a.http(path, { token: eve.token, ...(body ? { body } : {}) });
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect((await wellKnown(a)).server_key).toBe(key);
    expect(await a.store.operatorAuditLog()).toEqual([]);
    // Signed out: not even the route's existence.
    expectStatus(await a.http("/admin/federation"), 401);
  });
});

describe("where a rotated key is kept (the database, sealed by the root key)", () => {
  it("never stores the private key in the clear, and won't fall back to the root key", async () => {
    expectStatus(await rotate(a, opA), 200);
    const current = await ownKeys(a.env);
    const row = await a.store.connections.ownKey();
    expect(row?.publicKey).toBe(current?.current.publicKey);
    const d = /"d":"([^"]+)"/.exec(JSON.stringify(row))?.[1];
    expect(d).toBeUndefined();
    // With a different root the sealed key can't be opened: no key, rather than a silent swap.
    const other = await net.server("c.test");
    const wrongRoot = dbKeyStore(a.env, other.env.federationKey as string);
    expect(await wrongRoot.load()).toBeUndefined();
    // The root key itself is unchanged and is not the signing key any more.
    const root = await loadServerKey(a.env.federationKey as string);
    expect(publicKeyOf(a.env.federationKey as string)).toBe(root.publicKey);
    expect(root.publicKey).not.toBe(current?.current.publicKey);
  });
});
