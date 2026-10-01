// Federation v1 conformance: the frozen wire mechanics (spec §9.4). These vectors must keep
// passing for as long as v1 exists. NEVER edit a v1 vector to make a test pass: a change that
// needs one is a breaking change, and breaking changes need v2 (CONTRIBUTING.md).
import { readFileSync } from "node:fs";
import * as fed from "@openloungephone/federation";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { compare, compareAll } from "./schemaCompat.ts";
import { FEDERATION_SCHEMAS, GATED, snapshotAll } from "./schemas.ts";
import { withUnknownFields } from "./tolerance.ts";

const load = (file: string) =>
  JSON.parse(readFileSync(new URL(`./federation-v1/${file}`, import.meta.url), "utf8"));
const utf8 = (s: string) => new TextEncoder().encode(s);
const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("RFC 9421 signatures (spec §4)", () => {
  const sigs = load("signatures.json");

  it("the vectors are self-consistent: each signature verifies over its base with key a", async () => {
    for (const v of sigs.vectors) {
      const sig = v.headers.signature.match(/^sig1=:(.+):$/)[1];
      expect(
        await fed.verifySignature(sigs.keys.a.publicKey, utf8(v.base), bytes(sig)),
        v.name,
      ).toBe(true);
    }
  });

  it("signing the same request gives exactly the same headers (profile, base, encoding)", async () => {
    const key = await fed.loadServerKey(JSON.stringify(sigs.keys.a.jwk));
    expect(key.publicKey).toBe(sigs.keys.a.publicKey);
    for (const v of sigs.vectors) {
      const body =
        v.body !== undefined ? utf8(v.body) : v.bodyBase64 ? bytes(v.bodyBase64) : undefined;
      const headers = await fed.signRequest({
        method: v.method,
        url: v.url,
        body,
        keyId: v.keyId,
        privateKey: key.privateKey,
        now: v.created * 1000,
        nonce: v.nonce,
      });
      expect(headers, v.name).toEqual(v.headers);
    }
  });

  it("a receiver accepts each vector at its time, and rejects it tampered, late or replayed", async () => {
    for (const v of sigs.vectors) {
      const body =
        v.body !== undefined ? utf8(v.body) : v.bodyBase64 ? bytes(v.bodyBase64) : undefined;
      const seen = new Set<string>();
      const verify = (over: Partial<fed.VerifyInput> = {}) =>
        fed.verifyRequest({
          method: v.method,
          url: v.url,
          headers: new Headers(v.headers),
          body,
          now: v.created * 1000,
          resolveKey: async (id) => (id === v.keyId ? sigs.keys.a.publicKey : undefined),
          useNonce: async (id, n) => !seen.has(`${id} ${n}`) && !!seen.add(`${id} ${n}`),
          ...over,
        });
      expect(await verify(), v.name).toEqual({ ok: true, keyId: v.keyId });
      expect(await verify(), v.name).toEqual({ ok: false, reason: "replay" });
      seen.clear();
      expect(await verify({ now: (v.created + 301) * 1000 })).toEqual({
        ok: false,
        reason: "expired",
      });
      expect(await verify({ url: v.url.replace("/fed/v1/", "/fed/v2/") })).toEqual({
        ok: false,
        reason: "bad_signature",
      });
      expect(await verify({ method: "PUT" })).toEqual({ ok: false, reason: "bad_signature" });
      if (body) {
        expect(await verify({ body: utf8("tampered") })).toEqual({ ok: false, reason: "digest" });
      }
    }
  });

  it("Content-Digest is sha-256 of the exact body bytes, standard base64 between colons", async () => {
    for (const v of load("content-digest.json").vectors) {
      expect(await fed.contentDigest(utf8(v.body))).toBe(v.digest);
    }
  });
});

describe("key rotation (spec §3.2)", () => {
  const r = load("key-rotation.json");

  it("the statement and both signatures are exactly as specified", async () => {
    const w = r.wellKnown.rotation;
    expect(
      fed.keyRotationStatement({
        host: "a.example",
        previousKey: r.keys.a.publicKey,
        newKey: r.keys.b.publicKey,
        created: w.created,
        expires: w.expires,
      }),
    ).toBe(r.statement);
    expect(r.statement.split("\n")[0]).toBe("openloungephone-key-rotation-v2");
    const a = await fed.loadServerKey(JSON.stringify(r.keys.a.jwk));
    expect(await fed.signBytes(a, r.statement)).toBe(r.sig);
    expect(fed.rotationStatement(r.keys.b.publicKey)).toBe(r.legacy.statement);
    expect(await fed.signBytes(a, r.legacy.statement)).toBe(r.legacy.sig);
  });

  it("a receiver that pinned the old key decides exactly as the vectors say", async () => {
    const doc = fed.WellKnown.parse(r.wellKnown);
    for (const c of r.checks) {
      expect(
        await fed.checkRotation(doc, r.keys.a.publicKey, c.host, c.now * 1000),
        JSON.stringify(c),
      ).toEqual(c.result);
    }
    // The 0.1 pair alone is never enough.
    const { rotation: _, ...legacyOnly } = r.wellKnown;
    expect(
      await fed.checkRotation(
        fed.WellKnown.parse(legacyOnly),
        r.keys.a.publicKey,
        "a.example",
        r.checks[0].now * 1000,
      ),
    ).toEqual({ ok: false, reason: "none" });
  });
});

describe("the stream handshake (spec §6.1)", () => {
  const s = load("stream-hello.json");

  it("statements and signatures are exactly as specified, and the frames parse", async () => {
    for (const [frame, key] of [
      [s.hello, s.keys.a.publicKey],
      [s.helloOk, s.keys.b.publicKey],
    ]) {
      expect(fed.streamStatement(frame.from, frame.to, frame.created, frame.nonce)).toBe(
        frame.statement,
      );
      expect(frame.statement.startsWith("olp-stream-v1\n")).toBe(true);
      expect(await fed.verifyBytes(key, frame.statement, frame.sig)).toBe(true);
      const { statement: _, ...wire } = frame;
      expect(fed.StreamHello.parse(withUnknownFields(wire))).toEqual(wire);
    }
    expect(s.helloOk.nonce).toBe(s.hello.nonce);
  });
});

describe("messages (spec §7)", () => {
  it("every example parses, and parses the same with unknown fields added (tolerance)", () => {
    for (const ex of load("messages.json").examples) {
      const schema = FEDERATION_SCHEMAS[ex.schema] as z.ZodType;
      expect(schema, ex.schema).toBeDefined();
      const parsed = schema.safeParse(ex.json);
      expect(parsed.success, `${ex.schema} ${JSON.stringify(ex.json)}`).toBe(true);
      expect(schema.parse(withUnknownFields(ex.json)), ex.schema).toEqual(parsed.data);
    }
  });

  it("every .well-known parses, and a receiver reads versions and features as the vectors say", () => {
    for (const ex of load("well-known.json").examples) {
      const doc = fed.WellKnown.parse(ex.json);
      expect(fed.WellKnown.parse(withUnknownFields(ex.json))).toEqual(doc);
      const offer = fed.peerOffer(doc);
      expect(offer.versions, ex.name).toEqual(
        Object.fromEntries(Object.entries(ex.offer.versions).map(([k, v]) => [Number(k), v])),
      );
      expect(offer.legacy, ex.name).toBe(ex.offer.legacyFeatures);
      const n = fed.negotiate(offer, [1]);
      expect(n.ok ? n.version : null, ex.name).toBe(ex.offer.negotiated);
    }
  });
});

describe("the v1 schema snapshot (additive changes only)", () => {
  const snapshot = load("schemas.json");

  it("no field was removed, renamed, made required or optional, or changed type or limits", () => {
    const diff = compareAll(snapshot, snapshotAll(FEDERATION_SCHEMAS), GATED);
    expect(diff.breaking).toEqual([]);
  });

  it("the comparison catches breaking changes and allows additive ones", () => {
    const knock = snapshot.KnockBody;
    const clone = () => structuredClone(knock);
    const renamed = clone();
    renamed.properties.recipient = renamed.properties.to;
    delete renamed.properties.to;
    renamed.required = ["from", "recipient"];
    expect(compare(knock, renamed).breaking).toContain("to: removed or renamed");
    const required = clone();
    required.required = [...required.required, "note"];
    expect(compare(knock, required).breaking).toContain("note: made required");
    const narrowed = clone();
    narrowed.properties.note.maxLength = 100;
    expect(compare(knock, narrowed).breaking).toEqual(["note: maxLength 140 → 100"]);
    const added = clone();
    added.properties.mood = { type: "string" };
    expect(compare(knock, added)).toEqual({ breaking: [], additive: ["mood: new optional field"] });
    const addedRequired = clone();
    addedRequired.properties.mood = { type: "string" };
    addedRequired.required = [...addedRequired.required, "mood"];
    expect(compare(knock, addedRequired).breaking).toEqual(["mood: new required field"]);
    // A new call end reason is breaking unless it's introduced behind a feature.
    const result = snapshot.CallResult;
    const more = structuredClone(result);
    const ended = more.anyOf.find(
      (v: { properties: { state: { const: string } } }) => v.properties.state.const === "ended",
    );
    ended.properties.reason.enum.push("forwarded");
    expect(compare(result, more).breaking).toEqual([
      '#ended.reason: enum value "forwarded" added outside a feature',
    ]);
    expect(compare(result, more, ["#ended.reason=forwarded"]).breaking).toEqual([]);
  });
});
