import { describe, expect, it } from "vitest";
import { formatAddress, isFederatableHost, parseAddress } from "./address.ts";
import { generateServerKey, loadServerKey, rotationStatement, signBytes } from "./keys.ts";
import { NONCE_TTL_MS, signRequest, type VerifyInput, verifyRequest } from "./signature.ts";
import { baseUrlFor, rotationTrusted, WellKnown } from "./wellKnown.ts";

const NOW = Date.UTC(2026, 8, 28, 12);
const URL_ = "https://b.example/fed/v1/knock";
const body = new TextEncoder().encode(JSON.stringify({ hello: "world" }));

async function setup() {
  const key = await loadServerKey(await generateServerKey());
  const seen = new Set<string>();
  const headers = await signRequest({
    method: "POST",
    url: URL_,
    body,
    keyId: "a.example",
    privateKey: key.privateKey,
    now: NOW,
  });
  const verify = (over: Partial<VerifyInput> & { hdrs?: Record<string, string> } = {}) =>
    verifyRequest({
      method: "POST",
      url: URL_,
      headers: new Headers(over.hdrs ?? headers),
      body,
      now: NOW,
      resolveKey: async (id) => (id === "a.example" ? key.publicKey : undefined),
      useNonce: async (id, nonce) => {
        const k = `${id} ${nonce}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
      ...over,
    });
  return { key, headers, verify };
}

describe("RFC 9421 request signatures", () => {
  it("round-trips, and the base covers method, target URI and body digest", async () => {
    const { headers, verify } = await setup();
    expect(headers["signature-input"]).toMatch(
      /^sig1=\("@method" "@target-uri" "content-digest"\);created=\d+;keyid="a\.example";alg="ed25519";nonce="[\w-]+"$/,
    );
    expect(headers["content-digest"]).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
    expect(await verify()).toEqual({ ok: true, keyId: "a.example" });
  });

  it("rejects replays, stale or future timestamps", async () => {
    const { verify } = await setup();
    expect((await verify()).ok).toBe(true);
    expect(await verify()).toEqual({ ok: false, reason: "replay" });
    const { verify: v2 } = await setup();
    expect(await v2({ now: NOW + 5 * 60_000 + 1000 })).toEqual({ ok: false, reason: "expired" });
    expect(await v2({ now: NOW - 5 * 60_000 - 1000 })).toEqual({ ok: false, reason: "expired" });
    expect((await v2({ now: NOW + 4 * 60_000 })).ok).toBe(true);
    expect(NONCE_TTL_MS).toBeGreaterThan(10 * 60_000);
  });

  it("rejects tampering with the body, method, URL, key id or signature", async () => {
    const { verify, headers } = await setup();
    const other = new TextEncoder().encode('{"hello":"mars"}');
    expect(await verify({ body: other })).toEqual({ ok: false, reason: "digest" });
    expect(await verify({ method: "PUT" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ url: "https://b.example/fed/v1/other" })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const spoofed = headers["signature-input"]?.replace('keyid="a.example"', 'keyid="c.example"');
    expect(await verify({ hdrs: { ...headers, "signature-input": spoofed as string } })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    const sig = headers.signature as string;
    const flipped = `${sig.slice(0, 6)}${sig[6] === "A" ? "B" : "A"}${sig.slice(7)}`;
    expect(await verify({ hdrs: { ...headers, signature: flipped } })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    const noDigest = headers["signature-input"]?.replace(' "content-digest"', "");
    expect(await verify({ hdrs: { ...headers, "signature-input": noDigest as string } })).toEqual({
      ok: false,
      reason: "components",
    });
    expect(await verify({ hdrs: {} })).toEqual({ ok: false, reason: "missing" });
    // A bad signature doesn't consume the nonce: the genuine request still goes through.
    expect((await verify()).ok).toBe(true);
  });

  it("rejects a signature by a different key, and retries once for a rotated key", async () => {
    const { headers } = await setup();
    const stranger = await loadServerKey(await generateServerKey());
    const base = {
      method: "POST",
      url: URL_,
      headers: new Headers(headers),
      body,
      now: NOW,
      useNonce: async () => true,
    };
    const tries: boolean[] = [];
    const bad = await verifyRequest({
      ...base,
      resolveKey: async (_id, retry) => {
        tries.push(retry);
        return stranger.publicKey;
      },
    });
    expect(bad).toEqual({ ok: false, reason: "bad_signature" });
    expect(tries).toEqual([false, true]);
  });
});

describe("server keys and discovery", () => {
  it("trusts a rotation only when the pinned key signed it", async () => {
    const old = await loadServerKey(await generateServerKey());
    const next = await loadServerKey(await generateServerKey());
    const doc = WellKnown.parse({
      version: 1,
      server_key: next.publicKey,
      federation: "/fed/v1",
      previous_key: old.publicKey,
      rotation_sig: await signBytes(old, rotationStatement(next.publicKey)),
    });
    expect(await rotationTrusted(doc, old.publicKey)).toBe(true);
    expect(await rotationTrusted(doc, next.publicKey)).toBe(false);
    const forged = {
      ...doc,
      rotation_sig: await signBytes(next, rotationStatement(next.publicKey)),
    };
    expect(await rotationTrusted(forged, old.publicKey)).toBe(false);
  });

  it("uses https except for localhost names", () => {
    expect(baseUrlFor("hub.openloungephone.app")).toBe("https://hub.openloungephone.app");
    expect(baseUrlFor("a.localhost:8787")).toBe("http://a.localhost:8787");
    expect(baseUrlFor("localhost:8787")).toBe("http://localhost:8787");
    expect(baseUrlFor("localhost.evil.com")).toBe("https://localhost.evil.com");
  });

  it("parses addresses", () => {
    expect(parseAddress(" Jesse@L1.OpenLoungePhone.app ")).toEqual({
      handle: "jesse",
      host: "l1.openloungephone.app",
    });
    expect(parseAddress("@bob@b.localhost:8788")).toEqual({
      handle: "bob",
      host: "b.localhost:8788",
    });
    for (const bad of [
      "bob",
      "@host",
      "bob@",
      "b@host",
      "bob@host/x",
      "bob@user@host:99999999",
      "bob@-x.com",
    ]) {
      expect(parseAddress(bad), bad).toBeUndefined();
    }
    expect(formatAddress({ handle: "a.b", host: "h" })).toBe("a.b@h");
  });
});

describe("isFederatableHost", () => {
  it("a public server talks only to public names", () => {
    const me = "hub.example.org";
    expect(isFederatableHost("l1.openloungephone.app", me)).toBe(true);
    expect(isFederatableHost("phone.example.com:8443", me)).toBe(true);
    for (const bad of [
      "localhost",
      "localhost:6379",
      "a.localhost:8787",
      "127.0.0.1",
      "10.0.0.5:80",
      "169.254.169.254",
      "intranet",
      "printer.local",
      "db.internal",
      "nas.home.arpa",
      "[::1]",
    ]) {
      expect(isFederatableHost(bad, me), bad).toBe(false);
    }
  });

  it("a development server on a loopback name may talk to other loopback servers", () => {
    expect(isFederatableHost("b.localhost:8788", "a.localhost:8787")).toBe(true);
    expect(isFederatableHost("hub.example.org", "localhost:8787")).toBe(true);
    expect(isFederatableHost("127.0.0.1", "a.localhost:8787")).toBe(false);
  });
});
